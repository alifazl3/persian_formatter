// Package datecore converts dates between the Jalali (Shamsi) and Gregorian
// calendars and handles format detection/formatting. The actual calendar math
// is delegated to a proven library so conversions stay exact (including leap
// years); we only add parsing, validation and formatting around it.
package datecore

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	ptime "github.com/yaa110/go-persian-calendar"
)

// Format describes how a date string is laid out.
type Format struct {
	Order     string `json:"order"`     // permutation of y/m/d, e.g. "ymd", "dmy"
	YearW     int    `json:"yearW"`     // 2 or 4
	MonthW    int    `json:"monthW"`    // 1 or 2
	DayW      int    `json:"dayW"`      // 1 or 2
	Separator string `json:"separator"` // "/", "-", ".", " ", "" …
}

// Pattern renders the format as a human pattern like "yyyy/mm/dd".
func (f Format) Pattern() string {
	tok := map[byte]string{
		'y': strings.Repeat("y", max(f.YearW, 1)),
		'm': strings.Repeat("m", max(f.MonthW, 1)),
		'd': strings.Repeat("d", max(f.DayW, 1)),
	}
	parts := make([]string, 0, 3)
	for i := 0; i < len(f.Order); i++ {
		parts = append(parts, tok[f.Order[i]])
	}
	return strings.Join(parts, f.Separator)
}

// Options controls a conversion.
type Options struct {
	From         string `json:"from"`         // "auto" | "jalali" | "gregorian"
	To           string `json:"to"`           // "auto" | "jalali" | "gregorian"
	InputFormat  string `json:"inputFormat"`  // "" / "auto" = detect, else a pattern
	OutputFormat string `json:"outputFormat"` // "" / "same" = mirror input, else a pattern
	OrderHint    string `json:"orderHint"`    // ambiguous day/month fallback: "dmy" | "mdy"
}

// Result is the outcome returned to the caller (JSON-friendly).
type Result struct {
	OK             bool   `json:"ok"`
	Error          string `json:"error,omitempty"`
	InputFormat    string `json:"inputFormat,omitempty"`
	InputCalendar  string `json:"inputCalendar,omitempty"`
	OrderAmbiguous bool   `json:"orderAmbiguous"`
	Output         string `json:"output,omitempty"`
	OutputCalendar string `json:"outputCalendar,omitempty"`
	OutputFormat   string `json:"outputFormat,omitempty"`
}

func normalizeDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= '۰' && r <= '۹': // Persian
			b.WriteRune('0' + (r - '۰'))
		case r >= '٠' && r <= '٩': // Arabic-Indic
			b.WriteRune('0' + (r - '٠'))
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func isDigit(r rune) bool { return r >= '0' && r <= '9' }

// parsePattern turns a pattern like "dd/mm/yyyy" into a Format.
func parsePattern(p string) (Format, error) {
	p = strings.ToLower(strings.TrimSpace(p))
	var f Format
	for _, r := range p {
		if r != 'y' && r != 'm' && r != 'd' {
			f.Separator = string(r)
			break
		}
	}
	var groups []string
	if f.Separator != "" {
		groups = strings.Split(p, f.Separator)
	} else {
		// No separator: split into runs of the same letter.
		var cur strings.Builder
		for i, r := range p {
			if i > 0 && byte(r) != p[i-1] {
				groups = append(groups, cur.String())
				cur.Reset()
			}
			cur.WriteRune(r)
		}
		if cur.Len() > 0 {
			groups = append(groups, cur.String())
		}
	}
	for _, g := range groups {
		if g == "" {
			continue
		}
		switch g[0] {
		case 'y':
			f.Order += "y"
			f.YearW = len(g)
		case 'm':
			f.Order += "m"
			f.MonthW = len(g)
		case 'd':
			f.Order += "d"
			f.DayW = len(g)
		default:
			return f, fmt.Errorf("invalid pattern token %q", g)
		}
	}
	if len(f.Order) != 3 {
		return f, errors.New("pattern must contain year, month and day")
	}
	return f, nil
}

// splitParts splits a normalized date string into its (token, separator).
func splitParts(s string) (tokens []string, sep string, err error) {
	for _, r := range s {
		if !isDigit(r) {
			sep = string(r)
			break
		}
	}
	if sep == "" {
		if len(s) == 8 { // compact yyyymmdd
			return []string{s[0:4], s[4:6], s[6:8]}, "", nil
		}
		return nil, "", errors.New("could not find a separator")
	}
	for _, t := range strings.Split(s, sep) {
		if t != "" {
			tokens = append(tokens, t)
		}
	}
	if len(tokens) != 3 {
		return nil, sep, fmt.Errorf("expected 3 parts, got %d", len(tokens))
	}
	return tokens, sep, nil
}

// detect parses the input and returns components, the detected format,
// the calendar, and whether day/month order had to be guessed.
func detect(input string, opt Options) (y, m, d int, f Format, calendar string, ambiguous bool, err error) {
	s := strings.TrimSpace(normalizeDigits(input))
	if s == "" {
		err = errors.New("empty input")
		return
	}

	explicit := opt.InputFormat != "" && opt.InputFormat != "auto"
	tokens, sep, e := splitParts(s)
	if e != nil {
		err = e
		return
	}
	nums := make([]int, 3)
	widths := make([]int, 3)
	for i, t := range tokens {
		widths[i] = len(t)
		n, ce := strconv.Atoi(t)
		if ce != nil {
			err = fmt.Errorf("invalid number %q", t)
			return
		}
		nums[i] = n
	}

	if explicit {
		pf, pe := parsePattern(opt.InputFormat)
		if pe != nil {
			err = pe
			return
		}
		pf.Separator = sep // honor the actual separator in the data
		f = pf
		for i := 0; i < 3; i++ {
			switch f.Order[i] {
			case 'y':
				y = nums[i]
			case 'm':
				m = nums[i]
			case 'd':
				d = nums[i]
			}
		}
	} else {
		// Year: a 4-wide token, otherwise a value > 31.
		yi := -1
		for i := range nums {
			if widths[i] == 4 {
				yi = i
				break
			}
		}
		if yi == -1 {
			for i := range nums {
				if nums[i] > 31 {
					yi = i
					break
				}
			}
		}
		if yi == -1 {
			yi = 2 // last, common default
		}
		y = nums[yi]

		// The other two positions are day and month, in original order.
		var rest []int
		for i := range nums {
			if i != yi {
				rest = append(rest, i)
			}
		}
		a, b := rest[0], rest[1]

		// Default order when day vs month is ambiguous: ISO (year-first) means
		// month-first; otherwise (year last/middle) day-first — both common.
		dayFirst := yi != 0
		if opt.OrderHint != "" {
			dayFirst = strings.Index(opt.OrderHint, "d") < strings.Index(opt.OrderHint, "m")
		}

		var dPos, mPos int
		switch {
		case nums[a] > 12:
			dPos, mPos = a, b
		case nums[b] > 12:
			dPos, mPos = b, a
		default:
			ambiguous = true
			if dayFirst {
				dPos, mPos = a, b
			} else {
				dPos, mPos = b, a
			}
		}
		d, m = nums[dPos], nums[mPos]

		ord := make([]byte, 3)
		ord[yi], ord[dPos], ord[mPos] = 'y', 'd', 'm'
		f = Format{
			Order:     string(ord),
			YearW:     widths[yi],
			MonthW:    widths[mPos],
			DayW:      widths[dPos],
			Separator: sep,
		}
	}

	calendar = opt.From
	if calendar == "" || calendar == "auto" {
		if y < 1700 {
			calendar = "jalali"
		} else {
			calendar = "gregorian"
		}
	}
	return
}

func formatDate(y, m, d int, f Format) string {
	pad := func(v, w int) string {
		s := strconv.Itoa(v)
		for len(s) < w {
			s = "0" + s
		}
		if w == 2 && len(s) > 2 { // yy → last two digits
			s = s[len(s)-2:]
		}
		return s
	}
	val := map[byte]string{
		'y': pad(y, max(f.YearW, 1)),
		'm': pad(m, max(f.MonthW, 1)),
		'd': pad(d, max(f.DayW, 1)),
	}
	parts := make([]string, 0, 3)
	for i := 0; i < len(f.Order); i++ {
		parts = append(parts, val[f.Order[i]])
	}
	return strings.Join(parts, f.Separator)
}

// jalaliToGregorian converts and validates a Jalali date. It returns an error
// for impossible dates (e.g. 1402/12/30) rather than silently normalizing.
func jalaliToGregorian(y, m, d int) (int, int, int, error) {
	if m < 1 || m > 12 || d < 1 || d > 31 {
		return 0, 0, 0, fmt.Errorf("invalid jalali date %04d/%02d/%02d", y, m, d)
	}
	pt := ptime.Date(y, ptime.Month(m), d, 0, 0, 0, 0, time.UTC)
	if pt.Year() != y || int(pt.Month()) != m || pt.Day() != d {
		return 0, 0, 0, fmt.Errorf("invalid jalali date %04d/%02d/%02d", y, m, d)
	}
	g := pt.Time().UTC()
	return g.Year(), int(g.Month()), g.Day(), nil
}

// gregorianToJalali converts and validates a Gregorian date.
func gregorianToJalali(y, m, d int) (int, int, int, error) {
	if m < 1 || m > 12 || d < 1 || d > 31 {
		return 0, 0, 0, fmt.Errorf("invalid gregorian date %04d/%02d/%02d", y, m, d)
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if t.Year() != y || int(t.Month()) != m || t.Day() != d {
		return 0, 0, 0, fmt.Errorf("invalid gregorian date %04d/%02d/%02d", y, m, d)
	}
	pj := ptime.New(t)
	return pj.Year(), int(pj.Month()), pj.Day(), nil
}

// Convert is the single entry point used by the WASM glue.
func Convert(input string, opt Options) Result {
	y, m, d, inFmt, inCal, ambiguous, err := detect(input, opt)
	if err != nil {
		return Result{OK: false, Error: err.Error()}
	}

	outCal := opt.To
	if outCal == "" || outCal == "auto" {
		if inCal == "jalali" {
			outCal = "gregorian"
		} else {
			outCal = "jalali"
		}
	}

	var oy, om, od int
	var cerr error
	switch {
	case inCal == outCal:
		oy, om, od = y, m, d
		if inCal == "jalali" {
			_, _, _, cerr = jalaliToGregorian(y, m, d) // validate
		} else {
			_, _, _, cerr = gregorianToJalali(y, m, d)
		}
	case inCal == "jalali" && outCal == "gregorian":
		oy, om, od, cerr = jalaliToGregorian(y, m, d)
	case inCal == "gregorian" && outCal == "jalali":
		oy, om, od, cerr = gregorianToJalali(y, m, d)
	default:
		cerr = fmt.Errorf("unsupported calendars %q -> %q", inCal, outCal)
	}
	if cerr != nil {
		return Result{OK: false, Error: cerr.Error(), InputFormat: inFmt.Pattern(), InputCalendar: inCal, OrderAmbiguous: ambiguous}
	}

	outFmt := inFmt
	if opt.OutputFormat != "" && opt.OutputFormat != "same" {
		pf, pe := parsePattern(opt.OutputFormat)
		if pe != nil {
			return Result{OK: false, Error: pe.Error()}
		}
		outFmt = pf
	}

	return Result{
		OK:             true,
		InputFormat:    inFmt.Pattern(),
		InputCalendar:  inCal,
		OrderAmbiguous: ambiguous,
		Output:         formatDate(oy, om, od, outFmt),
		OutputCalendar: outCal,
		OutputFormat:   outFmt.Pattern(),
	}
}

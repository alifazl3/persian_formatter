// Month-name date support: parsing inputs like "June 14, 1946",
// "25 شهریور 1403" or "16 سپتامبر 2024", and rendering layout patterns that
// contain month-name tokens (mmm / mmmm).
package datecore

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// namedMonth is one recognized month-name token.
type namedMonth struct {
	month int
	cal   string // calendar the name implies: "gregorian" | "jalali"
	lang  string // "en" | "fa"
	short bool   // an abbreviation like "Jun" (echoed back as mmm, not mmmm)
}

var monthNames = map[string]namedMonth{}

func addMonths(cal, lang string, short bool, names map[string]int) {
	for n, m := range names {
		monthNames[n] = namedMonth{month: m, cal: cal, lang: lang, short: short}
	}
}

func init() {
	addMonths("gregorian", "en", false, map[string]int{
		"january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
		"july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
	})
	addMonths("gregorian", "en", true, map[string]int{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7,
		"aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
	})
	addMonths("jalali", "fa", false, map[string]int{
		"فروردین": 1, "اردیبهشت": 2, "خرداد": 3, "تیر": 4, "مرداد": 5, "امرداد": 5,
		"شهریور": 6, "مهر": 7, "آبان": 8, "ابان": 8, "آذر": 9, "اذر": 9,
		"دی": 10, "بهمن": 11, "اسفند": 12,
	})
	// Gregorian months written in Persian, with common spelling variants.
	addMonths("gregorian", "fa", false, map[string]int{
		"ژانویه": 1, "فوریه": 2, "مارس": 3, "مارچ": 3, "آوریل": 4, "اوریل": 4, "اپریل": 4,
		"مه": 5, "می": 5, "ژوئن": 6, "جون": 6, "ژوئیه": 7, "ژوییه": 7, "جولای": 7,
		"اوت": 8, "آگوست": 8, "اگوست": 8, "سپتامبر": 9, "اکتبر": 10, "نوامبر": 11, "دسامبر": 12,
	})
}

// normalizeToken lowercases (for English) and maps Arabic letter variants to
// their Persian forms so "شهريور" (Arabic yeh) still matches.
func normalizeToken(tok string) string {
	tok = strings.ToLower(tok)
	return strings.Map(func(r rune) rune {
		switch r {
		case 'ي':
			return 'ی'
		case 'ك':
			return 'ک'
		}
		return r
	}, tok)
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !isDigit(r) {
			return false
		}
	}
	return true
}

// stripOrdinal turns "14th" into "14" (st/nd/rd/th suffixes).
func stripOrdinal(tok string) string {
	for _, suf := range []string{"st", "nd", "rd", "th"} {
		if num, found := strings.CutSuffix(tok, suf); found && allDigits(num) {
			return num
		}
	}
	return tok
}

// detectNamed parses a date whose month is written as a name. ok=false means
// "not a named date — try the numeric path"; err non-nil means it clearly was
// a named date but is malformed (missing day/year, day out of range …).
func detectNamed(s string) (y, m, d int, cal, lang, layout string, ok bool, err error) {
	fields := strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == ',' || r == '،' || r == '.' || r == '‌'
	})

	type numTok struct{ val, width, pos int }
	var nums []numTok
	var mn namedMonth
	monthPos := -1

	for i, raw := range fields {
		tok := normalizeToken(raw)
		if tok == "" || tok == "of" || tok == "the" {
			continue
		}
		if got, hit := monthNames[tok]; hit {
			if monthPos != -1 {
				return 0, 0, 0, "", "", "", false, nil // two month names — not a date
			}
			mn, monthPos = got, i
			continue
		}
		digits := stripOrdinal(tok)
		if !allDigits(digits) {
			return 0, 0, 0, "", "", "", false, nil // unknown word — not a named date
		}
		n, _ := strconv.Atoi(digits)
		nums = append(nums, numTok{val: n, width: len(digits), pos: i})
	}
	if monthPos == -1 {
		return 0, 0, 0, "", "", "", false, nil
	}
	if len(nums) != 2 {
		return 0, 0, 0, "", "", "", true,
			errors.New("تاریخ با نام ماه باید روز و سال داشته باشد (مثل June 14, 1946)")
	}

	// Pick which number is the year: 4 digits wins, then a value > 31,
	// otherwise the later token (e.g. "June 14, 46").
	a, b := nums[0], nums[1]
	var yr, dy numTok
	switch {
	case a.width == 4 && b.width != 4:
		yr, dy = a, b
	case b.width == 4 && a.width != 4:
		yr, dy = b, a
	case a.val > 31:
		yr, dy = a, b
	case b.val > 31:
		yr, dy = b, a
	default:
		yr, dy = b, a
	}
	if dy.val < 1 || dy.val > 31 {
		return 0, 0, 0, "", "", "", true, fmt.Errorf("روز نامعتبر است: %d", dy.val)
	}

	monthTok := "mmmm"
	if mn.short {
		monthTok = "mmm"
	}
	yearTok := "yyyy"
	if yr.width <= 2 {
		yearTok = "yy"
	}

	// Echo the layout in the order the user wrote it.
	if monthPos < dy.pos { // month first: "June 14, 1946"
		layout = monthTok + " d, " + yearTok
	} else { // day first: "14 June 1946" / "25 شهریور 1403"
		layout = "d " + monthTok + " " + yearTok
	}
	return yr.val, mn.month, dy.val, mn.cal, mn.lang, layout, true, nil
}

var faJalaliMonthNames = [12]string{
	"فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
	"مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
}
var faGregorianMonthNames = [12]string{
	"ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن",
	"ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر",
}
var enGregorianMonthNames = [12]string{
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
}

func monthDisplayName(m int, cal, lang string, short bool) string {
	if m < 1 || m > 12 {
		return "?"
	}
	if cal == "jalali" {
		return faJalaliMonthNames[m-1]
	}
	if lang == "fa" {
		return faGregorianMonthNames[m-1]
	}
	name := enGregorianMonthNames[m-1]
	if short && len(name) > 3 {
		name = name[:3]
	}
	return name
}

// FaWeekdays is indexed by Go's time.Weekday (Sunday = 0).
var FaWeekdays = [7]string{
	"یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه",
}

// FormatLayout renders a date with a layout pattern. Token runs: yyyy/yy/y,
// mmmm (full month name) / mmm (short name) / mm / m, dd / d. Every other
// character is kept literally. cal picks the month-name table; lang picks the
// language for Gregorian names ("fa" → سپتامبر, otherwise September).
func FormatLayout(y, m, d int, layout, cal, lang string) string {
	var b strings.Builder
	rs := []rune(layout)
	for i := 0; i < len(rs); {
		c := rs[i]
		if c != 'y' && c != 'm' && c != 'd' {
			b.WriteRune(c)
			i++
			continue
		}
		j := i
		for j < len(rs) && rs[j] == c {
			j++
		}
		n := j - i
		switch c {
		case 'y':
			s := strconv.Itoa(y)
			if n == 2 && len(s) > 2 {
				s = s[len(s)-2:]
			}
			w := 1
			if n == 2 {
				w = 2
			} else if n >= 3 {
				w = 4
			}
			for len(s) < w {
				s = "0" + s
			}
			b.WriteString(s)
		case 'm':
			switch {
			case n >= 4:
				b.WriteString(monthDisplayName(m, cal, lang, false))
			case n == 3:
				b.WriteString(monthDisplayName(m, cal, lang, true))
			case n == 2:
				fmt.Fprintf(&b, "%02d", m)
			default:
				b.WriteString(strconv.Itoa(m))
			}
		case 'd':
			if n >= 2 {
				fmt.Fprintf(&b, "%02d", d)
			} else {
				b.WriteString(strconv.Itoa(d))
			}
		}
		i = j
	}
	return b.String()
}

// validLayout requires a custom layout to produce year, month and day.
func validLayout(layout string) bool {
	return strings.ContainsRune(layout, 'y') &&
		strings.ContainsRune(layout, 'm') &&
		strings.ContainsRune(layout, 'd')
}

// defaultNamedLayout mirrors "month written as a name" into the output
// calendar's natural order: Persian dates read day-first, English month-first.
func defaultNamedLayout(cal, lang string) string {
	if cal == "gregorian" && lang != "fa" {
		return "mmmm d, yyyy"
	}
	return "d mmmm yyyy"
}

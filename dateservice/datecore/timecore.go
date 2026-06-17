// Time/timezone conversion built on top of the date core. It interprets a
// wall-clock moment in a source IANA zone and re-expresses it in a target zone.
// DST is handled by Go's time package with the embedded IANA database (the wasm
// build imports time/tzdata), so summer/winter transitions are exact and
// historical rule changes (e.g. Iran abolishing DST from 1402/2023) are honored.
package datecore

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// TimeOptions controls a combined date/time + timezone conversion. When Time is
// empty it degrades to a pure calendar conversion (zones ignored).
type TimeOptions struct {
	Date         string `json:"date"`         // date in jalali or gregorian; "" = today (in fromZone)
	Time         string `json:"time"`         // "HH:MM" / "HH:MM:SS"; "" = date-only (no timezone shift)
	FromZone     string `json:"fromZone"`     // IANA zone, e.g. "Asia/Tehran"
	ToZone       string `json:"toZone"`       // IANA zone
	FromCalendar string `json:"fromCalendar"` // "auto" | "jalali" | "gregorian"; default auto
	OutCalendar  string `json:"outCalendar"`  // "auto" | "jalali" | "gregorian"; default auto (opposite)
	InputFormat  string `json:"inputFormat"`  // "" / "auto" = detect, else a pattern
	OrderHint    string `json:"orderHint"`    // ambiguous day/month fallback for the date part
}

// TimeResult is the JSON-friendly outcome.
type TimeResult struct {
	OK             bool   `json:"ok"`
	Error          string `json:"error,omitempty"`
	InputDate      string `json:"inputDate,omitempty"` // gregorian date used (echo), yyyy-mm-dd
	InputTime      string `json:"inputTime,omitempty"` // HH:MM
	InputCalendar  string `json:"inputCalendar,omitempty"`
	InputFormat    string `json:"inputFormat,omitempty"` // detected/used pattern
	OrderAmbiguous bool   `json:"orderAmbiguous"`        // day/month order had to be guessed
	FromOffset     string `json:"fromOffset,omitempty"`
	FromAbbr       string `json:"fromAbbr,omitempty"`
	OutputDate     string `json:"outputDate,omitempty"` // in OutputCalendar
	OutputTime     string `json:"outputTime,omitempty"` // HH:MM ("" when date-only)
	OutputCalendar string `json:"outputCalendar,omitempty"`
	ToOffset       string `json:"toOffset,omitempty"`
	ToAbbr         string `json:"toAbbr,omitempty"`
	DayShift       int    `json:"dayShift"`    // output date − input date in days (… −1, 0, +1 …)
	NonExistent    bool   `json:"nonExistent"` // wall clock falls in a spring-forward gap
	Ambiguous      bool   `json:"ambiguous"`   // wall clock falls in a fall-back overlap
}

func parseClock(s string) (h, mi, sec int, err error) {
	s = strings.TrimSpace(normalizeDigits(s))
	if s == "" {
		return 0, 0, 0, nil
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, 0, 0, errors.New("invalid time; use HH:MM")
	}
	vals := make([]int, len(parts))
	for i, p := range parts {
		v, e := strconv.Atoi(strings.TrimSpace(p))
		if e != nil {
			return 0, 0, 0, errors.New("invalid time; use HH:MM")
		}
		vals[i] = v
	}
	h, mi = vals[0], vals[1]
	if len(vals) == 3 {
		sec = vals[2]
	}
	if h < 0 || h > 23 || mi < 0 || mi > 59 || sec < 0 || sec > 59 {
		return 0, 0, 0, errors.New("time out of range")
	}
	return h, mi, sec, nil
}

func offsetString(sec int) string {
	sign := "+"
	if sec < 0 {
		sign = "-"
		sec = -sec
	}
	return fmt.Sprintf("%s%02d:%02d", sign, sec/3600, (sec%3600)/60)
}

// zoneAbbr returns the zone's short name only when it is a real abbreviation
// (e.g. "EDT"); numeric names like "+0330" are dropped since we show the offset.
func zoneAbbr(t time.Time) string {
	name, _ := t.Zone()
	if name == "" || name[0] == '+' || name[0] == '-' {
		return ""
	}
	return name
}

// classifyWall reports whether the wall-clock time that produced t is
// non-existent (spring-forward gap) or ambiguous (fall-back overlap) in t's
// location. We detect by behavior, not by trusting which side Go picked:
//   - gap: re-reading t's wall clock no longer matches the requested one.
//   - overlap: an instant one DST step away renders the very same wall clock.
func classifyWall(t time.Time, y, mo, d, h, mi int) (nonExistent, ambiguous bool) {
	if t.Year() != y || int(t.Month()) != mo || t.Day() != d || t.Hour() != h || t.Minute() != mi {
		return true, false
	}
	for _, delta := range []time.Duration{-time.Hour, time.Hour} {
		o := t.Add(delta)
		if !o.Equal(t) && o.Day() == d && o.Hour() == h && o.Minute() == mi {
			return false, true
		}
	}
	return false, false
}

// ConvertTime interprets Date+Time as a wall clock in FromZone and converts it
// to ToZone (and to the requested calendar), returning the re-expressed
// date/time plus offsets and DST flags. With an empty Time it performs a pure
// calendar conversion and applies no timezone shift.
func ConvertTime(opt TimeOptions) TimeResult {
	fromLoc, err := time.LoadLocation(strings.TrimSpace(opt.FromZone))
	if err != nil {
		return TimeResult{OK: false, Error: "منطقه‌ی زمانی ورودی نامعتبر است"}
	}
	toLoc, err := time.LoadLocation(strings.TrimSpace(opt.ToZone))
	if err != nil {
		return TimeResult{OK: false, Error: "منطقه‌ی زمانی خروجی نامعتبر است"}
	}

	// --- parse the date into a validated Gregorian y/m/d ---
	var gy, gm, gd int
	inCal := "gregorian"
	ambiguous := false
	inFmt := ""
	if dateStr := strings.TrimSpace(opt.Date); dateStr == "" {
		now := time.Now().In(fromLoc)
		gy, gm, gd = now.Year(), int(now.Month()), now.Day()
		if opt.FromCalendar == "jalali" {
			inCal = "jalali"
		}
	} else {
		fromCal := opt.FromCalendar
		if fromCal == "" {
			fromCal = "auto"
		}
		y, m, d, f, cal, amb, derr := detect(dateStr, Options{From: fromCal, OrderHint: opt.OrderHint, InputFormat: opt.InputFormat})
		if derr != nil {
			return TimeResult{OK: false, Error: derr.Error()}
		}
		inCal, ambiguous, inFmt = cal, amb, f.Pattern()
		if cal == "jalali" {
			if gy, gm, gd, derr = jalaliToGregorian(y, m, d); derr != nil {
				return TimeResult{OK: false, Error: derr.Error(), InputCalendar: cal, InputFormat: inFmt, OrderAmbiguous: amb}
			}
		} else {
			if _, _, _, verr := gregorianToJalali(y, m, d); verr != nil {
				return TimeResult{OK: false, Error: verr.Error(), InputCalendar: cal, InputFormat: inFmt, OrderAmbiguous: amb}
			}
			gy, gm, gd = y, m, d
		}
	}

	// --- pick the output calendar (auto = the opposite of the input) ---
	outCal := opt.OutCalendar
	if outCal == "" || outCal == "auto" {
		if inCal == "jalali" {
			outCal = "gregorian"
		} else {
			outCal = "jalali"
		}
	}
	fmtDate := func(y, mo, d int) (string, error) {
		if outCal == "jalali" {
			jy, jm, jd, e := gregorianToJalali(y, mo, d)
			if e != nil {
				return "", e
			}
			return fmt.Sprintf("%04d/%02d/%02d", jy, jm, jd), nil
		}
		return fmt.Sprintf("%04d/%02d/%02d", y, mo, d), nil
	}

	base := TimeResult{
		OK:             true,
		InputCalendar:  inCal,
		InputFormat:    inFmt,
		OrderAmbiguous: ambiguous,
		InputDate:      fmt.Sprintf("%04d-%02d-%02d", gy, gm, gd),
		OutputCalendar: outCal,
	}

	// --- date-only: pure calendar conversion, no timezone applied ---
	if strings.TrimSpace(opt.Time) == "" {
		outDate, e := fmtDate(gy, gm, gd)
		if e != nil {
			return TimeResult{OK: false, Error: e.Error()}
		}
		base.OutputDate = outDate
		return base
	}

	// --- date + time: full timezone conversion ---
	h, mi, sec, terr := parseClock(opt.Time)
	if terr != nil {
		return TimeResult{OK: false, Error: terr.Error()}
	}

	t := time.Date(gy, time.Month(gm), gd, h, mi, sec, 0, fromLoc)
	nonExistent, amb := classifyWall(t, gy, gm, gd, h, mi)
	out := t.In(toLoc)

	outDate, e := fmtDate(out.Year(), int(out.Month()), out.Day())
	if e != nil {
		return TimeResult{OK: false, Error: e.Error()}
	}

	_, fromOff := t.Zone()
	_, toOff := out.Zone()
	inAnchor := time.Date(gy, time.Month(gm), gd, 0, 0, 0, 0, time.UTC)
	outAnchor := time.Date(out.Year(), out.Month(), out.Day(), 0, 0, 0, 0, time.UTC)

	base.InputTime = fmt.Sprintf("%02d:%02d", h, mi)
	base.FromOffset = offsetString(fromOff)
	base.FromAbbr = zoneAbbr(t)
	base.OutputDate = outDate
	base.OutputTime = fmt.Sprintf("%02d:%02d", out.Hour(), out.Minute())
	base.ToOffset = offsetString(toOff)
	base.ToAbbr = zoneAbbr(out)
	base.DayShift = int(outAnchor.Sub(inAnchor).Hours()) / 24
	base.NonExistent = nonExistent
	base.Ambiguous = amb
	return base
}

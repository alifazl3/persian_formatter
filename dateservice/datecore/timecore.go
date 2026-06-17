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

// TimeOptions controls a timezone/time conversion.
type TimeOptions struct {
	Date        string `json:"date"`        // date in jalali or gregorian; "" = today (in fromZone)
	Time        string `json:"time"`        // "HH:MM" or "HH:MM:SS"; "" = 00:00
	FromZone    string `json:"fromZone"`    // IANA zone, e.g. "Asia/Tehran"
	ToZone      string `json:"toZone"`      // IANA zone
	OutCalendar string `json:"outCalendar"` // "jalali" | "gregorian"; default jalali
	OrderHint   string `json:"orderHint"`   // ambiguous day/month fallback for the date part
}

// TimeResult is the JSON-friendly outcome.
type TimeResult struct {
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	InputDate   string `json:"inputDate,omitempty"` // gregorian date used (echo), yyyy-mm-dd
	InputTime   string `json:"inputTime,omitempty"` // HH:MM
	FromOffset  string `json:"fromOffset,omitempty"`
	FromAbbr    string `json:"fromAbbr,omitempty"`
	OutputDate  string `json:"outputDate,omitempty"` // in OutCalendar
	OutputTime  string `json:"outputTime,omitempty"` // HH:MM
	ToOffset    string `json:"toOffset,omitempty"`
	ToAbbr      string `json:"toAbbr,omitempty"`
	DayShift    int    `json:"dayShift"`    // output date − input date in days (… −1, 0, +1 …)
	NonExistent bool   `json:"nonExistent"` // wall clock falls in a spring-forward gap
	Ambiguous   bool   `json:"ambiguous"`   // wall clock falls in a fall-back overlap
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
// to ToZone, returning the re-expressed date/time plus offsets and DST flags.
func ConvertTime(opt TimeOptions) TimeResult {
	fromLoc, err := time.LoadLocation(strings.TrimSpace(opt.FromZone))
	if err != nil {
		return TimeResult{OK: false, Error: "منطقه‌ی زمانی ورودی نامعتبر است"}
	}
	toLoc, err := time.LoadLocation(strings.TrimSpace(opt.ToZone))
	if err != nil {
		return TimeResult{OK: false, Error: "منطقه‌ی زمانی خروجی نامعتبر است"}
	}

	h, mi, sec, err := parseClock(opt.Time)
	if err != nil {
		return TimeResult{OK: false, Error: err.Error()}
	}

	var gy, gm, gd int
	if dateStr := strings.TrimSpace(opt.Date); dateStr == "" {
		now := time.Now().In(fromLoc)
		gy, gm, gd = now.Year(), int(now.Month()), now.Day()
	} else {
		y, m, d, _, cal, _, derr := detect(dateStr, Options{From: "auto", OrderHint: opt.OrderHint})
		if derr != nil {
			return TimeResult{OK: false, Error: derr.Error()}
		}
		if cal == "jalali" {
			if gy, gm, gd, derr = jalaliToGregorian(y, m, d); derr != nil {
				return TimeResult{OK: false, Error: derr.Error()}
			}
		} else {
			if _, _, _, verr := gregorianToJalali(y, m, d); verr != nil {
				return TimeResult{OK: false, Error: verr.Error()}
			}
			gy, gm, gd = y, m, d
		}
	}

	t := time.Date(gy, time.Month(gm), gd, h, mi, sec, 0, fromLoc)
	nonExistent, ambiguous := classifyWall(t, gy, gm, gd, h, mi)
	out := t.In(toLoc)

	_, fromOff := t.Zone()
	_, toOff := out.Zone()

	outCal := opt.OutCalendar
	if outCal == "" {
		outCal = "jalali"
	}
	var outDate string
	if outCal == "jalali" {
		jy, jm, jd, jerr := gregorianToJalali(out.Year(), int(out.Month()), out.Day())
		if jerr != nil {
			return TimeResult{OK: false, Error: jerr.Error()}
		}
		outDate = fmt.Sprintf("%04d/%02d/%02d", jy, jm, jd)
	} else {
		outDate = fmt.Sprintf("%04d/%02d/%02d", out.Year(), int(out.Month()), out.Day())
	}

	inAnchor := time.Date(gy, time.Month(gm), gd, 0, 0, 0, 0, time.UTC)
	outAnchor := time.Date(out.Year(), out.Month(), out.Day(), 0, 0, 0, 0, time.UTC)
	dayShift := int(outAnchor.Sub(inAnchor).Hours()) / 24

	return TimeResult{
		OK:          true,
		InputDate:   fmt.Sprintf("%04d-%02d-%02d", gy, gm, gd),
		InputTime:   fmt.Sprintf("%02d:%02d", h, mi),
		FromOffset:  offsetString(fromOff),
		FromAbbr:    zoneAbbr(t),
		OutputDate:  outDate,
		OutputTime:  fmt.Sprintf("%02d:%02d", out.Hour(), out.Minute()),
		ToOffset:    offsetString(toOff),
		ToAbbr:      zoneAbbr(out),
		DayShift:    dayShift,
		NonExistent: nonExistent,
		Ambiguous:   ambiguous,
	}
}

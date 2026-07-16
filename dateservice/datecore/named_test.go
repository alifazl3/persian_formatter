package datecore

import "testing"

// June 14, 1946 ↔ 24 Khordad 1325 is the anchor pair for named parsing.
func TestNamedInput(t *testing.T) {
	cases := []struct {
		in      string
		wantCal string // detected input calendar
		wantOut string // converted output (auto calendar, auto format)
	}{
		{"June 14, 1946", "gregorian", "24 خرداد 1325"},
		{"june 14 1946", "gregorian", "24 خرداد 1325"},
		{"Jun 14, 1946", "gregorian", "24 خرداد 1325"},
		{"14 June 1946", "gregorian", "24 خرداد 1325"},
		{"14th of June 1946", "gregorian", "24 خرداد 1325"},
		{"24 خرداد 1325", "jalali", "14 ژوئن 1946"},
		{"۲۴ خرداد ۱۳۲۵", "jalali", "14 ژوئن 1946"},
		{"14 ژوئن 1946", "gregorian", "24 خرداد 1325"},
		{"25 شهریور 1403", "jalali", "15 سپتامبر 2024"},
	}
	for _, c := range cases {
		r := Convert(c.in, Options{})
		if !r.OK {
			t.Fatalf("%q: unexpected error %q", c.in, r.Error)
		}
		if r.InputCalendar != c.wantCal {
			t.Errorf("%q: calendar %s, want %s", c.in, r.InputCalendar, c.wantCal)
		}
		if r.Output != c.wantOut {
			t.Errorf("%q => %q, want %q", c.in, r.Output, c.wantOut)
		}
		if r.OrderAmbiguous {
			t.Errorf("%q: named dates must never be ambiguous", c.in)
		}
	}
}

// A named month with a Persian-language input keeps the output in Persian.
func TestNamedFaGregorianOutput(t *testing.T) {
	r := Convert("25 شهریور 1403", Options{To: "gregorian", OutputFormat: "d mmmm yyyy"})
	if !r.OK {
		t.Fatalf("unexpected error %q", r.Error)
	}
	if r.Output != "15 سپتامبر 2024" {
		t.Errorf("got %q, want %q", r.Output, "15 سپتامبر 2024")
	}
}

func TestNamedMalformed(t *testing.T) {
	for _, in := range []string{"June 1946", "June 14 15 1946", "June 99, 1946"} {
		if r := Convert(in, Options{}); r.OK {
			t.Errorf("%q should be invalid, got %q", in, r.Output)
		}
	}
}

func TestFormatLayout(t *testing.T) {
	cases := []struct {
		layout, cal, lang, want string
	}{
		{"yyyy/mm/dd", "gregorian", "", "1946/06/14"},
		{"dd.mm.yy", "gregorian", "", "14.06.46"},
		{"mmmm d, yyyy", "gregorian", "en", "June 14, 1946"},
		{"mmm d, yyyy", "gregorian", "en", "Jun 14, 1946"},
		{"d mmmm yyyy", "gregorian", "fa", "14 ژوئن 1946"},
		{"d mmmm yyyy", "jalali", "fa", "14 شهریور 1946"},
	}
	for _, c := range cases {
		if got := FormatLayout(1946, 6, 14, c.layout, c.cal, c.lang); got != c.want {
			t.Errorf("FormatLayout(%q, %s, %s) = %q, want %q", c.layout, c.cal, c.lang, got, c.want)
		}
	}
}

func TestConvertTimeOutputFormatAndWeekday(t *testing.T) {
	r := ConvertTime(TimeOptions{
		Date: "June 14, 1946", FromZone: "UTC", ToZone: "UTC",
	})
	if !r.OK {
		t.Fatalf("unexpected error %q", r.Error)
	}
	if r.OutputDate != "24 خرداد 1325" {
		t.Errorf("OutputDate = %q, want %q", r.OutputDate, "24 خرداد 1325")
	}
	// June 14, 1946 was a Friday.
	if r.Weekday != "جمعه" {
		t.Errorf("Weekday = %q, want جمعه", r.Weekday)
	}

	r = ConvertTime(TimeOptions{
		Date: "1403/06/25", FromZone: "Asia/Tehran", ToZone: "Asia/Tehran",
		OutputFormat: "mmmm d, yyyy",
	})
	if !r.OK {
		t.Fatalf("unexpected error %q", r.Error)
	}
	if r.OutputDate != "September 15, 2024" {
		t.Errorf("OutputDate = %q, want %q", r.OutputDate, "September 15, 2024")
	}

	if r := ConvertTime(TimeOptions{Date: "2024-09-15", FromZone: "UTC", ToZone: "UTC", OutputFormat: "yyyy/mm"}); r.OK {
		t.Error("layout without a day token should be rejected")
	}
}

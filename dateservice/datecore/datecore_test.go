package datecore

import "testing"

// Well-established Nowruz (1 Farvardin) pairs — these anchor correctness.
func TestKnownPairs(t *testing.T) {
	cases := []struct {
		in, from, out string
	}{
		{"1403/01/01", "jalali", "2024/03/20"},
		{"1400/01/01", "jalali", "2021/03/21"},
		{"1399/01/01", "jalali", "2020/03/20"},
		{"1403/07/01", "jalali", "2024/09/22"}, // 1 Mehr 1403
		{"2024-09-15", "gregorian", "1403-06-25"},
	}
	for _, c := range cases {
		r := Convert(c.in, Options{From: c.from})
		if !r.OK {
			t.Fatalf("%s: unexpected error %q", c.in, r.Error)
		}
		if r.Output != c.out {
			t.Errorf("%s (%s) => %s, want %s", c.in, c.from, r.Output, c.out)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	dates := []string{"1403/01/01", "1403/06/31", "1403/12/29", "1399/12/30", "1402/06/15"}
	for _, d := range dates {
		g := Convert(d, Options{From: "jalali", To: "gregorian", OutputFormat: "yyyy/mm/dd"})
		if !g.OK {
			t.Fatalf("%s -> greg failed: %s", d, g.Error)
		}
		back := Convert(g.Output, Options{From: "gregorian", To: "jalali", OutputFormat: "yyyy/mm/dd"})
		if !back.OK {
			t.Fatalf("%s round-trip back failed: %s", d, back.Error)
		}
		if back.Output != d {
			t.Errorf("round-trip %s -> %s -> %s", d, g.Output, back.Output)
		}
	}
}

func TestInvalidDates(t *testing.T) {
	bad := []struct{ in, from, fmt string }{
		{"1403/07/31", "jalali", ""},                // Mehr has 30 days
		{"1403/13/01", "jalali", "yyyy/mm/dd"},       // no month 13 (pin order)
		{"1403/01/32", "jalali", ""},                 // no day 32
		{"2024/02/30", "gregorian", ""},              // Feb has 29 in 2024
		{"2023/02/29", "gregorian", ""},              // 2023 not a leap year
	}
	for _, c := range bad {
		r := Convert(c.in, Options{From: c.from, InputFormat: c.fmt})
		if r.OK {
			t.Errorf("%s (%s) should be invalid, got %s", c.in, c.from, r.Output)
		}
	}
}

func TestLeapYears(t *testing.T) {
	// Gregorian leap day round-trips.
	r := Convert("2024/02/29", Options{From: "gregorian", To: "jalali", OutputFormat: "yyyy/mm/dd"})
	if !r.OK {
		t.Fatalf("2024/02/29 should be valid: %s", r.Error)
	}
	back := Convert(r.Output, Options{From: "jalali", To: "gregorian", OutputFormat: "yyyy/mm/dd"})
	if !back.OK || back.Output != "2024/02/29" {
		t.Errorf("leap round-trip: %s -> %s -> %s (ok=%v)", "2024/02/29", r.Output, back.Output, back.OK)
	}
}

func TestAmbiguity(t *testing.T) {
	// Both parts <= 12 → order is ambiguous and must be flagged.
	r := Convert("1403/06/07", Options{From: "jalali"})
	if !r.OK || !r.OrderAmbiguous {
		t.Errorf("1403/06/07 should be flagged ambiguous (ok=%v amb=%v)", r.OK, r.OrderAmbiguous)
	}
	// A day > 12 resolves the order unambiguously.
	r2 := Convert("1403/25/06", Options{From: "jalali"})
	if r2.OrderAmbiguous {
		t.Errorf("1403/25/06 should not be ambiguous")
	}
}

func TestFormatEcho(t *testing.T) {
	r := Convert("2024-09-15", Options{})
	if r.InputFormat != "yyyy-mm-dd" {
		t.Errorf("detected format = %q, want yyyy-mm-dd", r.InputFormat)
	}
	if r.InputCalendar != "gregorian" {
		t.Errorf("detected calendar = %q, want gregorian", r.InputCalendar)
	}
	// Output mirrors the input format by default.
	if r.OutputFormat != "yyyy-mm-dd" {
		t.Errorf("output format = %q, want yyyy-mm-dd", r.OutputFormat)
	}
}

func TestExplicitFormatResolvesOrder(t *testing.T) {
	// Force mm/dd/yyyy reading.
	r := Convert("06/25/2024", Options{From: "gregorian", InputFormat: "mm/dd/yyyy", OutputFormat: "yyyy/mm/dd"})
	if !r.OK {
		t.Fatalf("err: %s", r.Error)
	}
	if r.Output != "1403/04/05" { // 25 June 2024 = 5 Tir 1403
		t.Errorf("06/25/2024 (mm/dd/yyyy) => %s, want 1403/04/05", r.Output)
	}
}

func TestYYWidth(t *testing.T) {
	r := Convert("1403/01/01", Options{From: "jalali", To: "gregorian", OutputFormat: "yy-mm-dd"})
	if !r.OK || r.Output != "24-03-20" {
		t.Errorf("yy width => %s (ok=%v), want 24-03-20", r.Output, r.OK)
	}
}

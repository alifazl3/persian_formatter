package datecore

import "testing"

// Tests run on the host, where time.LoadLocation reads the OS tzdata. The wasm
// build embeds tzdata (import _ "time/tzdata") so the same results hold offline.

func TestTehranDSTAbolished(t *testing.T) {
	// Iran observed DST (+04:30) through summer 2022; from 1402/2023 it is
	// +03:30 year-round. A summer conversion showing no shift in 2024 is
	// correct, not a bug.
	got := ConvertTime(TimeOptions{Date: "2021-07-01", Time: "12:00", FromZone: "Asia/Tehran", ToZone: "UTC", OutCalendar: "gregorian"})
	if !got.OK {
		t.Fatalf("2021 summer: %s", got.Error)
	}
	if got.FromOffset != "+04:30" {
		t.Errorf("2021 Tehran summer offset = %q, want +04:30", got.FromOffset)
	}
	if got.OutputTime != "07:30" {
		t.Errorf("2021 Tehran 12:00 -> UTC = %q, want 07:30", got.OutputTime)
	}

	got = ConvertTime(TimeOptions{Date: "2024-07-01", Time: "12:00", FromZone: "Asia/Tehran", ToZone: "UTC", OutCalendar: "gregorian"})
	if !got.OK {
		t.Fatalf("2024 summer: %s", got.Error)
	}
	if got.FromOffset != "+03:30" {
		t.Errorf("2024 Tehran summer offset = %q, want +03:30 (DST abolished)", got.FromOffset)
	}
	if got.OutputTime != "08:30" {
		t.Errorf("2024 Tehran 12:00 -> UTC = %q, want 08:30", got.OutputTime)
	}
}

func TestSpringForwardGap(t *testing.T) {
	// 2024-03-10 02:30 does not exist in America/New_York (02:00 -> 03:00).
	got := ConvertTime(TimeOptions{Date: "2024-03-10", Time: "02:30", FromZone: "America/New_York", ToZone: "UTC", OutCalendar: "gregorian"})
	if !got.OK {
		t.Fatalf("gap: %s", got.Error)
	}
	if !got.NonExistent {
		t.Errorf("2024-03-10 02:30 NY should be flagged non-existent")
	}
	if got.Ambiguous {
		t.Errorf("a gap must not also be flagged ambiguous")
	}
}

func TestFallBackOverlap(t *testing.T) {
	// 2024-11-03 01:30 occurs twice in America/New_York (01:00 EDT then 01:00 EST).
	got := ConvertTime(TimeOptions{Date: "2024-11-03", Time: "01:30", FromZone: "America/New_York", ToZone: "UTC", OutCalendar: "gregorian"})
	if !got.OK {
		t.Fatalf("overlap: %s", got.Error)
	}
	if !got.Ambiguous {
		t.Errorf("2024-11-03 01:30 NY should be flagged ambiguous")
	}
	if got.NonExistent {
		t.Errorf("an overlap must not also be flagged non-existent")
	}
}

func TestNormalTimeNoFlags(t *testing.T) {
	got := ConvertTime(TimeOptions{Date: "2024-06-15", Time: "12:00", FromZone: "America/New_York", ToZone: "UTC", OutCalendar: "gregorian"})
	if !got.OK {
		t.Fatalf("normal: %s", got.Error)
	}
	if got.NonExistent || got.Ambiguous {
		t.Errorf("a normal time must carry no DST flags (gap=%v overlap=%v)", got.NonExistent, got.Ambiguous)
	}
	if got.FromOffset != "-04:00" { // EDT in June
		t.Errorf("NY June offset = %q, want -04:00", got.FromOffset)
	}
	if got.OutputTime != "16:00" {
		t.Errorf("NY 12:00 June -> UTC = %q, want 16:00", got.OutputTime)
	}
}

func TestCrossMidnightDayShift(t *testing.T) {
	// Tehran 2024-09-15 02:00 (+03:30) = 2024-09-14 22:30 UTC = 15:30 the
	// previous day in Los Angeles (PDT -07:00).
	got := ConvertTime(TimeOptions{Date: "2024-09-15", Time: "02:00", FromZone: "Asia/Tehran", ToZone: "America/Los_Angeles", OutCalendar: "gregorian"})
	if !got.OK {
		t.Fatalf("cross-midnight: %s", got.Error)
	}
	if got.DayShift != -1 {
		t.Errorf("dayShift = %d, want -1", got.DayShift)
	}
	if got.OutputTime != "15:30" {
		t.Errorf("output time = %q, want 15:30", got.OutputTime)
	}
	if got.OutputDate != "2024/09/14" {
		t.Errorf("output date = %q, want 2024/09/14", got.OutputDate)
	}
}

func TestJalaliInputJalaliOutput(t *testing.T) {
	// 1403/06/25 14:30 Tehran -> New York. 1403/06/25 = 2024-09-15.
	// 14:30 +03:30 = 11:00 UTC = 07:00 EDT (-04:00), same calendar day.
	got := ConvertTime(TimeOptions{Date: "1403/06/25", Time: "14:30", FromZone: "Asia/Tehran", ToZone: "America/New_York", OutCalendar: "jalali"})
	if !got.OK {
		t.Fatalf("jalali: %s", got.Error)
	}
	if got.OutputTime != "07:00" {
		t.Errorf("output time = %q, want 07:00", got.OutputTime)
	}
	if got.OutputDate != "1403/06/25" {
		t.Errorf("output date = %q, want 1403/06/25", got.OutputDate)
	}
	if got.DayShift != 0 {
		t.Errorf("dayShift = %d, want 0", got.DayShift)
	}
	if got.InputDate != "2024-09-15" {
		t.Errorf("echoed gregorian input = %q, want 2024-09-15", got.InputDate)
	}
}

func TestInvalidZoneAndTime(t *testing.T) {
	if r := ConvertTime(TimeOptions{Date: "2024-01-01", Time: "12:00", FromZone: "Mars/Phobos", ToZone: "UTC"}); r.OK {
		t.Errorf("invalid zone should fail")
	}
	if r := ConvertTime(TimeOptions{Date: "2024-01-01", Time: "25:00", FromZone: "UTC", ToZone: "UTC"}); r.OK {
		t.Errorf("invalid hour should fail")
	}
}

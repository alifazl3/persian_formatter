//go:build js && wasm

// Command wasm exposes the date core to the browser as global JS functions:
//
//	goConvertDate(input, optionsJSON) — Jalali ⇄ Gregorian
//	goConvertTime(optionsJSON)        — timezone/time conversion (DST-aware)
//
// Both return a JSON string.
package main

import (
	"encoding/json"
	"syscall/js"
	_ "time/tzdata" // embed the full IANA tz database so DST is exact offline

	"dateservice/datecore"
)

func convert(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeString {
		return `{"ok":false,"error":"missing input"}`
	}
	input := args[0].String()

	var opt datecore.Options
	if len(args) >= 2 && args[1].Type() == js.TypeString {
		_ = json.Unmarshal([]byte(args[1].String()), &opt)
	}

	b, err := json.Marshal(datecore.Convert(input, opt))
	if err != nil {
		return `{"ok":false,"error":"encode failed"}`
	}
	return string(b)
}

func convertTime(_ js.Value, args []js.Value) any {
	var opt datecore.TimeOptions
	if len(args) >= 1 && args[0].Type() == js.TypeString {
		_ = json.Unmarshal([]byte(args[0].String()), &opt)
	}

	b, err := json.Marshal(datecore.ConvertTime(opt))
	if err != nil {
		return `{"ok":false,"error":"encode failed"}`
	}
	return string(b)
}

func main() {
	js.Global().Set("goConvertDate", js.FuncOf(convert))
	js.Global().Set("goConvertTime", js.FuncOf(convertTime))
	select {} // keep the Go runtime alive for callbacks
}

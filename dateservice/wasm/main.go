//go:build js && wasm

// Command wasm exposes datecore.Convert to the browser as a global JS function
// `goConvertDate(input, optionsJSON)` that returns a JSON string.
package main

import (
	"encoding/json"
	"syscall/js"

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

func main() {
	js.Global().Set("goConvertDate", js.FuncOf(convert))
	select {} // keep the Go runtime alive for callbacks
}

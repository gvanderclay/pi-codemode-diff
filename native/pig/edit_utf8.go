// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT
// Adapted from PiG e63c61c338e2aaf0d130513db2c2e63fe2e7dafd; see NOTICE.
package pig

import "strings"

type utf8StreamDecoder struct {
	stripBOM    bool
	started     bool
	codePoint   rune
	bytesSeen   int
	bytesNeeded int
	lower       byte
	upper       byte
}

func (d *utf8StreamDecoder) decode(data []byte, stream bool) string {
	var b strings.Builder
	b.Grow(len(data))
	if d.lower == 0 {
		d.lower, d.upper = 0x80, 0xBF
	}
	emit := func(r rune) {
		if !d.started {
			d.started = true
			if d.stripBOM && r == '\uFEFF' {
				return
			}
		}
		b.WriteRune(r)
	}
	for i := 0; i < len(data); i++ {
		c := data[i]
		if d.bytesNeeded == 0 {
			switch {
			case c <= 0x7F:
				emit(rune(c))
			case c >= 0xC2 && c <= 0xDF:
				d.bytesNeeded, d.codePoint = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				switch c {
				case 0xE0:
					d.lower = 0xA0
				case 0xED:
					d.upper = 0x9F
				}
				d.bytesNeeded, d.codePoint = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				switch c {
				case 0xF0:
					d.lower = 0x90
				case 0xF4:
					d.upper = 0x8F
				}
				d.bytesNeeded, d.codePoint = 3, rune(c&0x07)
			default:
				emit('�')
			}
			continue
		}
		if c < d.lower || c > d.upper {
			d.reset()
			emit('�')
			i-- // reprocess this byte as the start of a new sequence
			continue
		}
		d.lower, d.upper = 0x80, 0xBF
		d.codePoint = d.codePoint<<6 | rune(c&0x3F)
		d.bytesSeen++
		if d.bytesSeen == d.bytesNeeded {
			emit(d.codePoint)
			d.reset()
		}
	}
	if !stream && d.bytesNeeded != 0 {
		d.reset()
		emit('�')
	}
	return b.String()
}

func (d *utf8StreamDecoder) reset() {
	d.codePoint, d.bytesSeen, d.bytesNeeded = 0, 0, 0
	d.lower, d.upper = 0x80, 0xBF
}

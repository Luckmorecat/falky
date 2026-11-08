package image

import (
	"encoding/binary"
	"io"
	"os"

	"golang.org/x/image/vp8"
	"golang.org/x/image/vp8l"
)

func webpMetadata(f *os.File, size int64) (bool, int, error) {
	var header [12]byte
	if _, err := f.ReadAt(header[:], 0); err != nil {
		return false, 1, ErrInvalidImage
	}
	end := int64(binary.LittleEndian.Uint32(header[4:8])) + 8
	if end != size || end < 12 {
		return false, 1, ErrInvalidImage
	}
	animated := false
	orientation := 1
	for offset := int64(12); offset < end; {
		var chunk [8]byte
		if end-offset < 8 {
			return false, 1, ErrInvalidImage
		}
		if _, err := f.ReadAt(chunk[:], offset); err != nil {
			return false, 1, ErrInvalidImage
		}
		n := int64(binary.LittleEndian.Uint32(chunk[4:]))
		start := offset + 8
		next := start + n + n%2
		if next > end {
			return false, 1, ErrInvalidImage
		}
		switch string(chunk[:4]) {
		case "VP8X":
			var flags [1]byte
			if n != 10 {
				return false, 1, ErrInvalidImage
			}
			if _, err := f.ReadAt(flags[:], start); err != nil {
				return false, 1, ErrInvalidImage
			}
			animated = animated || flags[0]&2 != 0
		case "ANIM", "ANMF":
			animated = true
		case "EXIF":
			orientation = tiffOrientation(io.NewSectionReader(f, start, n), n)
		}
		offset = next
	}
	return animated, orientation, nil
}

func readOrientation(f *os.File, kind string) int {
	switch kind {
	case "webp":
		stat, err := f.Stat()
		if err != nil {
			return 1
		}
		_, o, err := webpMetadata(f, stat.Size())
		if err == nil {
			return o
		}
	case "jpeg":
		for offset := int64(2); ; {
			var marker [2]byte
			if _, err := f.ReadAt(marker[:], offset); err != nil || marker[0] != 255 {
				return 1
			}
			if marker[1] == 255 {
				offset++
				continue
			}
			if marker[1] == 0xda || marker[1] == 0xd9 {
				return 1
			}
			if marker[1] == 0x01 || marker[1] >= 0xd0 && marker[1] <= 0xd7 {
				offset += 2
				continue
			}
			var length [2]byte
			if _, err := f.ReadAt(length[:], offset+2); err != nil {
				return 1
			}
			n := int64(binary.BigEndian.Uint16(length[:]))
			if n < 2 {
				return 1
			}
			if marker[1] == 0xe1 && n >= 8 {
				var exif [6]byte
				if _, err := f.ReadAt(exif[:], offset+4); err == nil && string(exif[:]) == "Exif\x00\x00" {
					return tiffOrientation(io.NewSectionReader(f, offset+10, n-8), n-8)
				}
			}
			offset += n + 2
		}
	case "png":
		stat, err := f.Stat()
		if err != nil {
			return 1
		}
		for offset := int64(8); offset+12 <= stat.Size(); {
			var chunk [8]byte
			if _, err := f.ReadAt(chunk[:], offset); err != nil {
				return 1
			}
			n := int64(binary.BigEndian.Uint32(chunk[:4]))
			if n > stat.Size()-offset-12 {
				return 1
			}
			if string(chunk[4:]) == "eXIf" {
				return tiffOrientation(io.NewSectionReader(f, offset+8, n), n)
			}
			offset += n + 12
		}
	}
	return 1
}

// TIFF offsets stay inside a section reader. Metadata length never determines an
// allocation; even a large PNG eXIf chunk needs only one directory entry at a time.
func tiffOrientation(reader io.ReaderAt, size int64) int {
	var header [8]byte
	if _, err := reader.ReadAt(header[:], 0); err != nil {
		return 1
	}
	// WebP writers also emit the JPEG Exif prefix, despite TIFF being canonical.
	if string(header[:6]) == "Exif\x00\x00" {
		reader = io.NewSectionReader(reader, 6, size-6)
		size -= 6
		if _, err := reader.ReadAt(header[:], 0); err != nil {
			return 1
		}
	}
	var order binary.ByteOrder
	switch string(header[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(header[2:4]) != 42 {
		return 1
	}
	offset := int64(order.Uint32(header[4:]))
	if offset < 8 || offset > size-2 {
		return 1
	}
	var count [2]byte
	if _, err := reader.ReadAt(count[:], offset); err != nil {
		return 1
	}
	for i := 0; i < int(order.Uint16(count[:])); i++ {
		at := offset + 2 + int64(i)*12
		if at > size-12 {
			return 1
		}
		var entry [12]byte
		if _, err := reader.ReadAt(entry[:], at); err != nil {
			return 1
		}
		if order.Uint16(entry[:2]) == 0x112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			o := int(order.Uint16(entry[8:10]))
			if o >= 1 && o <= 8 {
				return o
			}
			return 1
		}
	}
	return 1
}

// DecodeConfig may return only VP8X canvas dimensions. Check the actual coded
// frame too, before the decoder can allocate pixels from its independent header.
func validateWebPFrames(f *os.File, width, height int) error {
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	frames := 0
	for offset := int64(12); offset < stat.Size(); {
		var chunk [8]byte
		if _, err := f.ReadAt(chunk[:], offset); err != nil {
			return ErrInvalidImage
		}
		n := int64(binary.LittleEndian.Uint32(chunk[4:]))
		reader := io.NewSectionReader(f, offset+8, n)
		var w, h int
		switch string(chunk[:4]) {
		case "VP8 ":
			d := vp8.NewDecoder()
			d.Init(reader, int(n))
			header, err := d.DecodeFrameHeader()
			if err != nil {
				return ErrInvalidImage
			}
			w, h = header.Width, header.Height
		case "VP8L":
			config, err := vp8l.DecodeConfig(reader)
			if err != nil {
				return ErrInvalidImage
			}
			w, h = config.Width, config.Height
		default:
			offset += 8 + n + n%2
			continue
		}
		if err := checkDimensions(w, h); err != nil {
			return err
		}
		if w != width || h != height {
			return ErrInvalidImage
		}
		frames++
		offset += 8 + n + n%2
	}
	if frames != 1 {
		return ErrInvalidImage
	}
	return nil
}

// APNG control/data chunks must be classified before image/png can decode only
// the default frame. Read headers only; chunk lengths never drive allocations.
func pngAnimated(f *os.File, size int64) (bool, error) {
	var signature [8]byte
	if _, err := f.ReadAt(signature[:], 0); err != nil || string(signature[:]) != "\x89PNG\r\n\x1a\n" {
		return false, ErrInvalidImage
	}
	animated := false
	for offset := int64(8); offset < size; {
		if size-offset < 12 {
			return false, ErrInvalidImage
		}
		var chunk [8]byte
		if _, err := f.ReadAt(chunk[:], offset); err != nil {
			return false, ErrInvalidImage
		}
		n := int64(binary.BigEndian.Uint32(chunk[:4]))
		if n > size-offset-12 {
			return false, ErrInvalidImage
		}
		switch string(chunk[4:]) {
		case "acTL":
			if n != 8 {
				return false, ErrInvalidImage
			}
			animated = true
		case "fcTL":
			if n != 26 {
				return false, ErrInvalidImage
			}
			animated = true
		case "fdAT":
			if n < 4 {
				return false, ErrInvalidImage
			}
			animated = true
		}
		offset += n + 12
	}
	return animated, nil
}

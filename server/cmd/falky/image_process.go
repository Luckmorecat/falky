package main

import (
	"io"

	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
)

func imageProcess(args []string, stdout io.Writer) int {
	if len(args) != 3 {
		return 2
	}
	return attachmentimage.RunWorker(args[1], args[2], stdout)
}

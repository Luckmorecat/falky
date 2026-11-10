package identity

import (
	"crypto/rand"
	_ "embed"
	"math/big"
	"strings"
)

// EFF short wordlist #1; see EFF-WORDLIST-LICENSE.md for source and license.
//
//go:embed eff_short_wordlist_1.txt
var recoveryWordlist string

var recoveryWords = func() []string {
	entries := strings.Fields(recoveryWordlist)
	words := make([]string, 0, len(entries)/2)
	for i := 1; i < len(entries); i += 2 {
		words = append(words, entries[i])
	}
	return words
}()

func newRecoveryPhrase() (string, error) {
	words := make([]string, 12)
	limit := big.NewInt(int64(len(recoveryWords)))
	for i := range words {
		index, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", err
		}
		words[i] = recoveryWords[index.Int64()]
	}
	return strings.Join(words, " "), nil
}

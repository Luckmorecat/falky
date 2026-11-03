package identity

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// maxNameLength is the longest name, in characters, after trimming.
const maxNameLength = 32

// reservationTime is how long entering holds the name for the new visitor.
const reservationTime = 60 * time.Second

// ErrInvalidName reports a name that breaks the name rules; the wrapping error
// says which.
var ErrInvalidName = errors.New("invalid name")

// ErrNameTaken reports a name another visitor holds.
var ErrNameTaken = errors.New("name taken")

// cleanName trims white space from both ends of raw and checks the name rules:
// 1 to 32 characters, none of them control characters. The bidirectional
// controls count as control characters, since they can make a name read as
// another.
func cleanName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	switch n := utf8.RuneCountInString(name); {
	case n == 0:
		return "", fmt.Errorf("%w: empty", ErrInvalidName)
	case n > maxNameLength:
		return "", fmt.Errorf("%w: longer than %d characters", ErrInvalidName, maxNameLength)
	case !utf8.ValidString(name):
		return "", fmt.Errorf("%w: not valid UTF-8", ErrInvalidName)
	case strings.ContainsFunc(name, isControl):
		return "", fmt.Errorf("%w: contains control characters", ErrInvalidName)
	}
	return name, nil
}

func isControl(r rune) bool {
	return unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r)
}

// nameKey is what names are compared by: trimmed and case-folded, so " Bob "
// and "bob" have the same key.
func nameKey(name string) string {
	return strings.Map(foldRune, strings.TrimSpace(name))
}

// foldRune maps r to the smallest rune that is equal to it under simple case
// folding, the folding strings.EqualFold uses.
func foldRune(r rune) rune {
	smallest := r
	for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
		smallest = min(smallest, f)
	}
	return smallest
}

// reservations tracks which visitor holds which name. Entering reserves the
// name for reservationTime; nothing else holds names yet.
type reservations struct {
	mu sync.Mutex
	// held maps a name key to the visitor holding it.
	held map[string]hold
}

type hold struct {
	visitorID string
	until     time.Time
}

func newReservations() *reservations {
	return &reservations{held: map[string]hold{}}
}

// takenBy reports whether a visitor other than visitorID holds key at now.
// The caller holds n.mu.
func (n *reservations) takenBy(key, visitorID string, now time.Time) bool {
	h, ok := n.held[key]
	return ok && h.visitorID != visitorID && now.Before(h.until)
}

// reserve makes visitorID hold key until now plus reservationTime, and drops
// lapsed holds. The caller holds n.mu.
func (n *reservations) reserve(key, visitorID string, now time.Time) {
	for k, h := range n.held {
		if !now.Before(h.until) {
			delete(n.held, k)
		}
	}
	n.held[key] = hold{visitorID: visitorID, until: now.Add(reservationTime)}
}

// move hands visitorID's hold, if it has one, from its old name to key. The
// caller holds n.mu.
func (n *reservations) move(key, visitorID string) {
	for k, h := range n.held {
		if h.visitorID == visitorID {
			delete(n.held, k)
			n.held[key] = h
			return
		}
	}
}

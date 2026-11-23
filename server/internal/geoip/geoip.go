package geoip

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	lookupTimeout        = 250 * time.Millisecond
	cacheTTL             = time.Minute
	cacheCapacity        = 256
	maxConcurrentLookups = 16
	maxResponseBytes     = 4096
)

type Location struct {
	CountryCode string `json:"countryCode"`
	City        string `json:"city"`
}

type cachedLocation struct {
	location Location
	expires  time.Time
}

type lookup struct {
	done     chan struct{}
	location Location
}

type Client struct {
	endpoint string
	http     *http.Client

	mu        sync.Mutex
	cache     map[netip.Addr]cachedLocation
	inFlight  map[netip.Addr]*lookup
	nextSweep time.Time
}

func New(baseURL string) *Client {
	if baseURL == "" {
		return nil
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &Client{
		endpoint: baseURL + "/v1/lookup",
		http: &http.Client{
			Transport: transport,
			Timeout:   lookupTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		cache:    make(map[netip.Addr]cachedLocation),
		inFlight: make(map[netip.Addr]*lookup),
	}
}

// Lookup returns an empty location when enrichment is unavailable.
func (c *Client) Lookup(ctx context.Context, ip string) Location {
	if c == nil {
		return Location{}
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil || addr.Zone() != "" {
		return Location{}
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return Location{}
	}
	c.mu.Lock()
	now := time.Now()
	if !now.Before(c.nextSweep) {
		maps.DeleteFunc(c.cache, func(_ netip.Addr, entry cachedLocation) bool { return !now.Before(entry.expires) })
		c.nextSweep = now.Add(cacheTTL)
	}
	if entry, ok := c.cache[addr]; ok && now.Before(entry.expires) {
		c.mu.Unlock()
		return entry.location
	}
	if active := c.inFlight[addr]; active != nil {
		c.mu.Unlock()
		select {
		case <-active.done:
			return active.location
		case <-ctx.Done():
			return Location{}
		}
	}
	if len(c.inFlight) >= maxConcurrentLookups {
		c.mu.Unlock()
		return Location{}
	}
	active := &lookup{done: make(chan struct{})}
	c.inFlight[addr] = active
	c.mu.Unlock()

	// The HTTP client's deadline keeps the shared lookup bounded if a caller leaves.
	location, ok := c.fetch(context.WithoutCancel(ctx), addr.String())
	c.mu.Lock()
	if ok {
		if _, exists := c.cache[addr]; !exists && len(c.cache) == cacheCapacity {
			for key := range c.cache {
				delete(c.cache, key)
				break
			}
		}
		c.cache[addr] = cachedLocation{location: location, expires: time.Now().Add(cacheTTL)}
	}
	active.location = location
	delete(c.inFlight, addr)
	close(active.done)
	c.mu.Unlock()
	return location
}

func (c *Client) fetch(ctx context.Context, ip string) (Location, bool) {
	body, err := json.Marshal(map[string]string{"ip": ip})
	if err != nil {
		return Location{}, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return Location{}, false
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return Location{}, false
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return Location{}, false
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	var location Location
	if err != nil || len(raw) > maxResponseBytes || json.Unmarshal(raw, &location) != nil {
		return Location{}, false
	}
	code := location.CountryCode
	if len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' {
		location.CountryCode = ""
	}
	location.City = strings.TrimSpace(location.City)
	if utf8.RuneCountInString(location.City) > 128 {
		location.City = ""
	}
	return location, true
}

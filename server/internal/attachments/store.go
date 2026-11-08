// Package attachments owns private attachment files, their lifecycle and quota.
package attachments

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
	"github.com/kisshot/falky/server/internal/platform"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

func Migrations() fs.FS {
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

const (
	MaxAttachments            = 4
	DraftTTL                  = time.Hour
	DefaultPostedBytes  int64 = 5_000_000_000
	DefaultStagingBytes int64 = 256 << 20
	MaxUploadStreams          = 4
)

var (
	uploadStreams = make(chan struct{}, MaxUploadStreams)
	processing    = make(chan struct{}, 1)
)

var (
	ErrNotFound           = errors.New("no such attachment")
	ErrExpired            = errors.New("attachment is unavailable")
	ErrInvalidAttachments = errors.New("invalid attachments")
	ErrTooLarge           = errors.New("attachment exceeds input limit")
	ErrStagingFull        = errors.New("attachment staging is full")
	ErrQuota              = errors.New("attachments cannot fit posted quota")
	ErrBusy               = errors.New("too many pending uploads")
	ErrRateLimited        = errors.New("too many uploads")
	ErrCleanupPending     = errors.New("attachment cleanup is pending")
	ErrClosed             = errors.New("attachment store is closed")
)

type Metadata struct {
	ID           string
	Filename     string
	ContentType  string
	Size         int64
	Inline       bool
	Width        int
	Height       int
	Availability string
	ExpiresAt    time.Time
}
type Record struct {
	Metadata
	RoomID string
}
type Content struct {
	Record
	File *os.File
}
type Expiry struct {
	RoomID string
	IDs    []string
}
type Limits struct {
	MaxFileBytes     int64
	MaxOutputBytes   int64
	StagingBytes     int64
	PostedBytes      int64
	MaxAttachments   int
	MaxPending       int
	MaxUploadStreams int
	MaxPixels        uint64
	MaxEdge          int
	MaxDimension     int
	DraftTTL         time.Duration
	ProcessTimeout   time.Duration
	UploadTimeout    time.Duration
	UploadBurst      int
	UploadRefill     time.Duration
}
type Processor interface {
	Process(context.Context, string, string) (attachmentimage.Result, error)
}
type Option func(*Store)

func WithProcessor(p Processor) Option { return func(s *Store) { s.processor = p } }

func WithClock(now func() time.Time) Option { return func(s *Store) { s.now = now } }

func WithPostedQuota(bytes int64) Option { return func(s *Store) { s.limits.PostedBytes = bytes } }

func WithStagingQuota(bytes int64) Option { return func(s *Store) { s.limits.StagingBytes = bytes } }

// WithExpiryPublisher receives committed expiry notifications. publish must not block.
func WithExpiryPublisher(publish func(Expiry)) Option { return func(s *Store) { s.publish = publish } }

// WithErrorHandler observes background cleanup failures without failing committed posts.
func WithErrorHandler(report func(error)) Option { return func(s *Store) { s.report = report } }

// WithFileRemover supplies the filesystem unlink operation, including fault injection.
func WithFileRemover(remove func(string) error) Option { return func(s *Store) { s.remove = remove } }

type Store struct {
	db        *platform.DB
	root      string
	processor Processor
	now       func() time.Time
	limits    Limits
	publish   func(Expiry)
	report    func(error)
	remove    func(string) error
	limiter   *platform.Limiter

	// Lock order: chat's publishing guard, mu, SQLite writer. Client reads
	// and child processing never hold mu.
	mu sync.Mutex

	active  map[string]bool
	closed  bool
	workers sync.WaitGroup
	ctx     context.Context
	cancel  context.CancelFunc
}

// New opens the private object namespace. Use one Store per database/root,
// and call Recover before admitting requests.
func New(db *platform.DB, root string, opts ...Option) (*Store, error) {
	s := &Store{db: db, root: filepath.Join(root, "objects"), processor: attachmentimage.NewProcessor(), now: time.Now, publish: func(Expiry) {}, report: func(error) {}, remove: os.Remove, active: map[string]bool{}}
	s.limits = Limits{MaxFileBytes: attachmentimage.MaxInputBytes, MaxOutputBytes: attachmentimage.MaxOutputBytes, StagingBytes: DefaultStagingBytes, PostedBytes: DefaultPostedBytes, MaxAttachments: MaxAttachments, MaxPending: MaxAttachments, MaxUploadStreams: MaxUploadStreams, MaxPixels: attachmentimage.MaxPixels, MaxEdge: attachmentimage.MaxEdge, MaxDimension: attachmentimage.MaxDimension, DraftTTL: DraftTTL, ProcessTimeout: attachmentimage.ProcessTimeout, UploadTimeout: time.Minute, UploadBurst: 4, UploadRefill: 15 * time.Second}
	for _, opt := range opts {
		opt(s)
	}
	if s.limits.PostedBytes <= 0 || s.limits.StagingBytes <= 0 || s.limits.StagingBytes > DefaultStagingBytes || s.processor == nil || s.now == nil || s.publish == nil || s.report == nil || s.remove == nil {
		return nil, errors.New("invalid attachment settings")
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(s.root, 0o700); err != nil {
		return nil, err
	}
	s.limiter = platform.NewLimiter(4, 15*time.Second, s.now)
	s.ctx, s.cancel = context.WithCancel(context.Background())
	return s, nil
}
func (s *Store) Limits() Limits                { return s.limits }
func (s *Store) path(id, suffix string) string { return filepath.Join(s.root, id+suffix) }

var objectName = regexp.MustCompile(`^[a-f0-9]{32}\.(source|work|data)$`)

func newID() (string, error) {
	var b [16]byte
	_, err := rand.Read(b[:])
	return hex.EncodeToString(b[:]), err
}

func safeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "attachment"
	}
	for len(name) > 240 {
		_, n := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-n]
	}
	return name
}

func (s *Store) Upload(ctx context.Context, owner, room, filename string, reader io.Reader) (Metadata, error) {
	select {
	case uploadStreams <- struct{}{}:
		defer func() { <-uploadStreams }()
	default:
		return Metadata{}, ErrBusy
	}
	id, err := newID()
	if err != nil {
		return Metadata{}, err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Metadata{}, ErrClosed
	}
	if !s.limiter.Allow(owner) {
		s.mu.Unlock()
		return Metadata{}, ErrRateLimited
	}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		var count int
		var used int64
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM attachments WHERE owner_id=? AND state IN ('incoming','ready')`, owner).Scan(&count); err != nil {
			return err
		}
		if count >= MaxAttachments {
			return ErrBusy
		}
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(sum(reserved),0) FROM attachments WHERE allocation='staging'`).Scan(&used); err != nil {
			return err
		}
		if used > s.limits.StagingBytes-s.limits.MaxFileBytes {
			return ErrStagingFull
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO attachments(id,owner_id,room_id,filename,state,allocation,reserved) VALUES(?,?,?,?,'incoming','staging',?)`, id, owner, room, safeFilename(filename), s.limits.MaxFileBytes)
		return err
	})
	if err != nil {
		s.mu.Unlock()
		return Metadata{}, err
	}
	s.active[id] = true
	s.workers.Add(1)
	s.mu.Unlock()
	defer s.workers.Done()
	uploadCtx, cancel := context.WithTimeout(ctx, s.limits.UploadTimeout)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	// HTTP sets a matching read deadline: cancellation cannot interrupt an
	// arbitrary Reader blocked inside Read.
	err = s.copySource(uploadCtx, id, reader)
	if err != nil {
		s.failUpload(id)
		return Metadata{}, err
	}
	select {
	case processing <- struct{}{}:
		defer func() { <-processing }()
	case <-uploadCtx.Done():
		s.failUpload(id)
		return Metadata{}, uploadCtx.Err()
	}
	s.mu.Lock()
	err = s.cleanupLocked(context.Background())
	s.mu.Unlock()
	if err != nil {
		s.failUpload(id)
		return Metadata{}, ErrCleanupPending
	}
	result, err := s.processor.Process(uploadCtx, s.path(id, ".source"), s.path(id, ".work"))
	if err != nil {
		s.failUpload(id)
		return Metadata{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = uploadCtx.Err(); err != nil {
		s.failUploadLocked(id)
		return Metadata{}, err
	}
	if result.Size < 0 || result.Size > s.limits.MaxOutputBytes || (!result.Optimized && result.Size > s.limits.MaxFileBytes) {
		s.failUploadLocked(id)
		return Metadata{}, ErrTooLarge
	}
	source := s.path(id, ".source")
	filename = safeFilename(filename)
	if result.Optimized {
		if err = s.unlink(source); err != nil {
			s.failUploadLocked(id)
			return Metadata{}, err
		}
		source = s.path(id, ".work")
		base := strings.TrimSuffix(filename, filepath.Ext(filename))
		if base == "" {
			base = "attachment"
		}
		filename = base + ".webp"
	}
	info, err := os.Stat(source)
	if err != nil || !info.Mode().IsRegular() || info.Size() != result.Size {
		s.failUploadLocked(id)
		if err != nil {
			return Metadata{}, err
		}
		return Metadata{}, attachmentimage.ErrProcessing
	}
	if err = os.Rename(source, s.path(id, ".data")); err != nil {
		s.failUploadLocked(id)
		return Metadata{}, err
	}
	if err = syncFile(s.path(id, ".data")); err == nil {
		err = syncFile(s.root)
	}
	if err != nil {
		s.failUploadLocked(id)
		return Metadata{}, err
	}
	var expiry time.Time
	err = s.db.Write(uploadCtx, func(tx *sql.Tx) error {
		expiry = s.now().Add(DraftTTL)
		var used int64
		if err := tx.QueryRowContext(uploadCtx, `SELECT coalesce(sum(reserved),0) FROM attachments WHERE allocation='staging' AND id<>?`, id).Scan(&used); err != nil {
			return err
		}
		if used > s.limits.StagingBytes-result.Size {
			return ErrStagingFull
		}
		r, err := tx.ExecContext(uploadCtx, `UPDATE attachments SET state='ready',filename=?,size=?,reserved=?,content_type=?,inline=?,width=?,height=?,expires_at=? WHERE id=? AND state='incoming'`, filename, result.Size, result.Size, result.ContentType, result.Inline, result.Width, result.Height, expiry.UnixMilli(), id)
		if err != nil {
			return err
		}
		n, err := r.RowsAffected()
		if err == nil && n != 1 {
			return ErrExpired
		}
		return err
	})
	if err != nil {
		s.failUploadLocked(id)
		return Metadata{}, err
	}
	delete(s.active, id)
	return Metadata{ID: id, Filename: filename, ContentType: result.ContentType, Size: result.Size, Inline: result.Inline, Width: result.Width, Height: result.Height, Availability: "ready", ExpiresAt: time.UnixMilli(expiry.UnixMilli()).UTC()}, nil
}

func (s *Store) copySource(ctx context.Context, id string, r io.Reader) error {
	f, err := os.OpenFile(s.path(id, ".source"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	input := &contextReader{ctx: ctx, r: r}
	n, err := io.Copy(f, io.LimitReader(input, s.limits.MaxFileBytes))
	if err == nil && n == s.limits.MaxFileBytes {
		var extra [1]byte
		count, probeErr := io.ReadFull(input, extra[:])
		if count > 0 {
			err = ErrTooLarge
		} else if !errors.Is(probeErr, io.EOF) {
			err = probeErr
		}
	}
	return errors.Join(err, f.Close())
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}

func (s *Store) unlink(path string) error {
	err := s.remove(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (s *Store) failUpload(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failUploadLocked(id)
}

func (s *Store) failUploadLocked(id string) {
	delete(s.active, id)
	// If the write fails, durable incoming state still lets startup recovery reclaim the files.
	if err := s.db.Write(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(context.Background(), `UPDATE attachments SET state='expired',cleanup=1 WHERE id=? AND state='incoming'`, id)
		return err
	}); err != nil {
		s.report(err)
	}
	if err := s.cleanupLocked(context.Background()); err != nil {
		s.report(err)
	}
}

const columns = `id,owner_id,room_id,filename,content_type,size,inline,width,height,state,expires_at,allocation,reserved,cleanup,message_id`

type record struct {
	Record
	owner, state, allocation string
	reserved                 int64
	cleanup                  bool
	message                  sql.NullString
}
type scanner interface{ Scan(...any) error }

func scan(row scanner) (record, error) {
	var r record
	var expires int64
	err := row.Scan(&r.ID, &r.owner, &r.RoomID, &r.Filename, &r.ContentType, &r.Size, &r.Inline, &r.Width, &r.Height, &r.state, &expires, &r.allocation, &r.reserved, &r.cleanup, &r.message)
	r.Availability = r.state
	if expires != 0 {
		r.ExpiresAt = time.UnixMilli(expires).UTC()
	}
	return r, err
}

func visible(r record, owner string) error {
	if r.state == "incoming" || (!r.message.Valid && r.owner != owner) {
		return ErrNotFound
	}
	return nil
}

func (s *Store) Visible(ctx context.Context, owner, id string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := scan(s.db.Read().QueryRowContext(ctx, `SELECT `+columns+` FROM attachments WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, err
	}
	if err = visible(r, owner); err != nil {
		return Record{}, err
	}
	if r.state == "ready" && !r.ExpiresAt.After(s.now()) {
		if err = s.expireLocked(ctx, r); err != nil {
			return Record{}, err
		}
		r.Availability = "expired"
	}
	if r.Availability == "ready" || r.Availability == "posted" {
		if _, err = os.Stat(s.path(id, ".data")); errors.Is(err, fs.ErrNotExist) {
			if err = s.expireLocked(ctx, r); err != nil {
				return Record{}, err
			}
			r.Availability = "expired"
		} else if err != nil {
			return Record{}, err
		}
	}
	return r.Record, nil
}

func (s *Store) Open(ctx context.Context, owner, id string) (Content, error) {
	if _, err := s.Visible(ctx, owner, id); err != nil {
		return Content{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := scan(s.db.Read().QueryRowContext(ctx, `SELECT `+columns+` FROM attachments WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Content{}, ErrNotFound
	}
	if err != nil {
		return Content{}, err
	}
	if err = visible(r, owner); err != nil {
		return Content{}, err
	}
	if r.state != "ready" && r.state != "posted" {
		return Content{}, ErrExpired
	}
	if r.state == "ready" && !r.ExpiresAt.After(s.now()) {
		if err = s.expireLocked(ctx, r); err != nil {
			return Content{}, err
		}
		return Content{}, ErrExpired
	}
	f, err := os.Open(s.path(id, ".data"))
	if errors.Is(err, fs.ErrNotExist) {
		if err = s.expireLocked(ctx, r); err != nil {
			return Content{}, err
		}
		return Content{}, ErrExpired
	}
	if err != nil {
		return Content{}, err
	}
	return Content{Record: r.Record, File: f}, nil
}

func (s *Store) Cancel(ctx context.Context, owner, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := scan(s.db.Read().QueryRowContext(ctx, `SELECT `+columns+` FROM attachments WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if r.owner != owner || r.message.Valid || r.state == "incoming" {
		return ErrNotFound
	}
	if r.state == "ready" {
		if err = s.db.Write(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE attachments SET state='cancelled',cleanup=1 WHERE id=?`, id)
			return err
		}); err != nil {
			return err
		}
	}
	return s.cleanupLocked(ctx)
}

func (s *Store) expireLocked(ctx context.Context, r record) error {
	if err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE attachments SET state='expired',cleanup=1 WHERE id=?`, r.ID)
		return err
	}); err != nil {
		return err
	}
	if r.message.Valid {
		s.publish(Expiry{RoomID: r.RoomID, IDs: []string{r.ID}})
	}
	if err := s.cleanupLocked(context.Background()); err != nil {
		s.report(err)
	}
	return nil
}

package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

type accountResponse struct {
	Header  http.Header
	Cookies []*http.Cookie
}

func accountRequest(t *testing.T, p publicServer, c *http.Client, method, path string, body any, origin string, want int) ([]byte, accountResponse) {
	t.Helper()
	var b []byte
	if body != nil {
		var err error
		b, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequestWithContext(t.Context(), method, p.srv.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := res.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s status %d, want %d", method, path, res.StatusCode, want)
	}
	return raw, accountResponse{Header: res.Header, Cookies: res.Cookies()}
}

type wireCeremony struct {
	ID      string          `json:"id"`
	Options json.RawMessage `json:"options"`
}

func beginAccount(t *testing.T, p publicServer, c *http.Client, path string, body any) wireCeremony {
	t.Helper()
	raw, res := accountRequest(t, p, c, "POST", path, body, testOrigin, 200)
	found := false
	for _, cookie := range res.Cookies {
		if cookie.Name == ceremonyCookie {
			found = true
			if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" || cookie.MaxAge < 300 || len(cookie.Value) != 52 {
				t.Fatal("unsafe browser context cookie")
			}
		}
	}
	if !found {
		t.Fatal("missing browser context cookie")
	}
	var ceremony wireCeremony
	if err := json.Unmarshal(raw, &ceremony); err != nil {
		t.Fatal(err)
	}
	return ceremony
}

func TestAccountFirstArrivalSignedEnrollmentAndLogin(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	invite, err := p.identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	begin := beginAccount(t, p, browser, "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": "Alice"})
	var options protocol.CredentialCreation
	if err := json.Unmarshal(begin.Options, &options); err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	signed := key.Registration(t, &options, testOrigin)
	finish := map[string]any{"ceremonyId": begin.ID, "credential": json.RawMessage(signed), "label": "Laptop"}
	raw, res := accountRequest(t, p, browser, "POST", "/api/accounts/registration/finish", finish, testOrigin, 200)
	var enrolled struct {
		Session struct {
			Visitor struct {
				ID string `json:"id"`
			} `json:"visitor"`
		} `json:"session"`
		Codes []string `json:"recoveryCodes"`
	}
	if err := json.Unmarshal(raw, &enrolled); err != nil {
		t.Fatal(err)
	}
	if enrolled.Session.Visitor.ID == "" || len(enrolled.Codes) != 1 {
		t.Fatal("missing identity or recovery codes")
	}
	var found bool
	for _, cookie := range res.Cookies {
		if cookie.Name == cookieName {
			found = true
			if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 90*24*60*60 {
				t.Fatal("unsafe account cookie")
			}
		}
	}
	if !found {
		t.Fatal("missing account cookie")
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/registration/finish", finish, testOrigin, 403)
	_, second := p.browserWithHTTP(t)
	login := beginAccount(t, p, second, "/api/accounts/authentication/begin", map[string]any{})
	var assertion protocol.CredentialAssertion
	if err := json.Unmarshal(login.Options, &assertion); err != nil {
		t.Fatal(err)
	}
	accountRequest(t, p, second, "POST", "/api/accounts/authentication/finish", map[string]any{"ceremonyId": login.ID, "credential": json.RawMessage(key.Assertion(t, &assertion, testOrigin))}, testOrigin, 200)
	me, _ := accountRequest(t, p, second, "GET", "/api/me", nil, "", 200)
	var visitor struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(me, &visitor); err != nil {
		t.Fatal(err)
	}
	if visitor.ID != enrolled.Session.Visitor.ID {
		t.Fatal("login changed identity")
	}
	target, err := url.Parse(p.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, staleBrowser := p.browserWithHTTP(t)
	staleBrowser.Jar.SetCookies(target, browser.Jar.Cookies(target))
	accountRequest(t, p, browser, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	accountRequest(t, p, staleBrowser, "GET", "/api/me", nil, "", 401)
	accountRequest(t, p, browser, "GET", "/api/me", nil, "", 401)
	accountRequest(t, p, second, "GET", "/api/me", nil, "", 200)
}

func TestAccountCeremoniesRejectForeignBrowserOriginPurposeAndReplay(t *testing.T) {
	p := startPublic(t, 100)
	_, a := p.browserWithHTTP(t)
	_, b := p.browserWithHTTP(t)
	invite, err := p.identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"invitation": invite.Token, "name": "Alice"}
	accountRequest(t, p, a, "POST", "/api/accounts/registration/begin", body, "https://foreign.example", 403)
	accountRequest(t, p, a, "POST", "/api/accounts/registration/begin", body, "", 403)
	ceremony := beginAccount(t, p, a, "/api/accounts/registration/begin", body)
	var options protocol.CredentialCreation
	if err := json.Unmarshal(ceremony.Options, &options); err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	finish := map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(key.Registration(t, &options, testOrigin))}
	accountRequest(t, p, b, "POST", "/api/accounts/registration/finish", finish, testOrigin, 403)
	beginAccount(t, p, b, "/api/accounts/authentication/begin", map[string]any{})
	accountRequest(t, p, b, "POST", "/api/accounts/registration/finish", finish, testOrigin, 403)
	accountRequest(t, p, a, "POST", "/api/accounts/authentication/finish", finish, testOrigin, 403)
	wrongOrigin := map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(key.Registration(t, &options, "https://foreign.example"))}
	accountRequest(t, p, a, "POST", "/api/accounts/registration/finish", wrongOrigin, testOrigin, 403)
	accountRequest(t, p, a, "GET", "/api/accounts/session", nil, "", 401)
	accountRequest(t, p, a, "POST", "/api/accounts/registration/finish", finish, testOrigin, 200)
	accountRequest(t, p, a, "POST", "/api/accounts/registration/finish", finish, testOrigin, 403)
	for _, entry := range []string{invite.Token, string(finish["credential"].(json.RawMessage))} {
		if strings.Contains(p.logs.String(), entry) {
			t.Fatal("bearer or credential leaked in logs")
		}
	}
}

func TestAccountHTTPBodyAndAttemptBounds(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	req, err := http.NewRequestWithContext(t.Context(), "POST", p.srv.URL+"/api/accounts/authentication/begin", strings.NewReader(strings.Repeat("x", maxRequestBody+1)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	res, err := browser.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 400 && res.StatusCode != 413 {
		t.Fatalf("oversized body status %d", res.StatusCode)
	}
	for i := 0; i < 19; i++ {
		beginAccount(t, p, browser, "/api/accounts/authentication/begin", map[string]any{})
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/authentication/begin", map[string]any{}, testOrigin, 429)
}

type enrolledAccount struct {
	Session struct {
		Visitor struct {
			ID string `json:"id"`
		} `json:"visitor"`
	} `json:"session"`
	RecoveryCodes []string `json:"recoveryCodes"`
}

func enrollAccount(t *testing.T, p publicServer, c *http.Client, name string, key *passkeytest.Authenticator) enrolledAccount {
	t.Helper()
	invite, err := p.identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ceremony := beginAccount(t, p, c, "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": name})
	return finishEnrollment(t, p, c, ceremony, key, "registration")
}

func finishEnrollment(t *testing.T, p publicServer, c *http.Client, ceremony wireCeremony, key *passkeytest.Authenticator, purpose string) enrolledAccount {
	t.Helper()
	var options protocol.CredentialCreation
	if err := json.Unmarshal(ceremony.Options, &options); err != nil {
		t.Fatal(err)
	}
	raw, res := accountRequest(t, p, c, "POST", "/api/accounts/"+purpose+"/finish", map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(key.Registration(t, &options, testOrigin))}, testOrigin, 200)
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("credential response can be cached")
	}
	var result enrolledAccount
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.RecoveryCodes) != 1 || len(strings.Fields(result.RecoveryCodes[0])) != 12 {
		t.Fatal("expected exactly one twelve-word recovery phrase")
	}
	return result
}

func TestAccountUpgradeRetainsIdentityAndRejectsGuestOnlyEnrollment(t *testing.T) {
	p := startPublic(t, 100)
	b, c := p.browserWithHTTP(t)
	guest := p.enter(t, b, "Guest")
	room := p.createRoom(t, "Lounge")
	message := posted(t, b, room.ID, "before-upgrade", "Guest message")
	draft := uploadDraft(t, p, c, room.ID, "before.txt", []byte("guest draft"))
	accountRequest(t, p, c, "POST", "/api/accounts/registration/begin", map[string]any{"invitation": p.secret, "name": "Alice"}, testOrigin, 403)
	invite, err := p.identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ceremony := beginAccount(t, p, c, "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": "Alice"})
	var options protocol.CredentialCreation
	if err := json.Unmarshal(ceremony.Options, &options); err != nil {
		t.Fatal(err)
	}
	bad := passkeytest.New(t)
	bad.CorruptSignature = true
	accountRequest(t, p, c, "POST", "/api/accounts/registration/finish", map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(bad.Registration(t, &options, testOrigin))}, testOrigin, 403)
	raw, _ := accountRequest(t, p, c, "GET", "/api/me", nil, "", 200)
	var before struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &before); err != nil {
		t.Fatal(err)
	}
	if before.ID != guest.Id {
		t.Fatal("failed enrollment changed guest")
	}
	enrolled := finishEnrollment(t, p, c, ceremony, passkeytest.New(t), "registration")
	if enrolled.Session.Visitor.ID != guest.Id {
		t.Fatal("upgrade lost identity")
	}
	postedMessageForAttachments(t, b, room.ID, "after-upgrade", api.PostMessageRequest{Body: "Owned draft", RequestKey: "after-upgrade", AttachmentIds: []string{draft.Id}})
	messages := history(t, b, room.ID, api.ListMessagesParams{})
	if len(messages) != 2 || messages[1].Id != message.Id || messages[1].AuthorId != guest.Id || messages[1].AuthorName != "Guest" || messages[0].AuthorId != guest.Id {
		t.Fatal("upgrade lost message ownership or name snapshot")
	}
	status, _, content := attachmentRequest(t, p, c, "GET", "/api/attachments/"+draft.Id+"/content", "", nil)
	if status != 200 || string(content) != "guest draft" {
		t.Fatal("upgrade lost attachment ownership")
	}
}

func TestOwnerPasskeyManagementRequiresOwnRecentProof(t *testing.T) {
	p := startPublic(t, 100)
	_, a := p.browserWithHTTP(t)
	_, b := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, a, "Alice", key)
	enrollAccount(t, p, b, "Bob", passkeytest.New(t))
	ceremony := beginAccount(t, p, a, "/api/accounts/passkeys/begin", map[string]any{})
	var options protocol.CredentialCreation
	if err := json.Unmarshal(ceremony.Options, &options); err != nil {
		t.Fatal(err)
	}
	second := passkeytest.New(t)
	body := map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(second.Registration(t, &options, testOrigin)), "label": "Phone"}
	accountRequest(t, p, b, "POST", "/api/accounts/passkeys/finish", body, testOrigin, 403)
	raw, _ := accountRequest(t, p, a, "POST", "/api/accounts/passkeys/finish", body, testOrigin, 200)
	var passkey struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &passkey); err != nil {
		t.Fatal(err)
	}
	accountRequest(t, p, b, "DELETE", "/api/accounts/passkeys/"+passkey.ID, nil, testOrigin, 403)
	accountRequest(t, p, a, "DELETE", "/api/accounts/passkeys/"+passkey.ID, nil, testOrigin, 200)
	raw, _ = accountRequest(t, p, a, "GET", "/api/accounts/passkeys", nil, "", 200)
	var keys struct {
		Passkeys []struct {
			ID string `json:"id"`
		} `json:"passkeys"`
	}
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys.Passkeys) != 1 {
		t.Fatal("wrong credential count")
	}
	accountRequest(t, p, a, "DELETE", "/api/accounts/passkeys/"+keys.Passkeys[0].ID, nil, testOrigin, 409)
	p.clock.Advance(6 * time.Minute)
	accountRequest(t, p, a, "POST", "/api/accounts/recovery-codes", map[string]any{}, testOrigin, 403)
	reauth := beginAccount(t, p, a, "/api/accounts/reauthentication/begin", map[string]any{})
	var assertion protocol.CredentialAssertion
	if err := json.Unmarshal(reauth.Options, &assertion); err != nil {
		t.Fatal(err)
	}
	proof := map[string]any{"ceremonyId": reauth.ID, "credential": json.RawMessage(key.Assertion(t, &assertion, testOrigin))}
	accountRequest(t, p, b, "POST", "/api/accounts/reauthentication/finish", proof, testOrigin, 403)
	accountRequest(t, p, a, "POST", "/api/accounts/reauthentication/finish", proof, testOrigin, 200)
	raw, _ = accountRequest(t, p, a, "POST", "/api/accounts/recovery-codes", map[string]any{}, testOrigin, 200)
	var codes struct {
		Codes []string `json:"recoveryCodes"`
	}
	if err := json.Unmarshal(raw, &codes); err != nil {
		t.Fatal(err)
	}
	if len(codes.Codes) != 1 || len(strings.Fields(codes.Codes[0])) != 12 {
		t.Fatal("missing new recovery codes")
	}
}

func TestAccountRecoveryReplacesAccessAndExpiryRejectsStaleCookie(t *testing.T) {
	p := startPublic(t, 100)
	_, a := p.browserWithHTTP(t)
	_, recovering := p.browserWithHTTP(t)
	account := enrollAccount(t, p, a, "Alice", passkeytest.New(t))
	id := account.Session.Visitor.ID
	expiredGrant, err := p.identity.IssueRecovery(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	p.clock.Advance(31 * time.Minute)
	accountRequest(t, p, a, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": expiredGrant.Token}, testOrigin, 403)
	grant, err := p.identity.IssueRecovery(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	accountRequest(t, p, a, "GET", "/api/me", nil, "", 200)
	operatorCeremony := beginAccount(t, p, recovering, "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": grant.Token})
	accountRequest(t, p, recovering, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": " " + grant.Token + "\n"}, testOrigin, 403)
	words := strings.Fields(account.RecoveryCodes[0])
	accountRequest(t, p, recovering, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": strings.Join(words[1:], " ")}, testOrigin, 403)
	formatted := " \t" + strings.ToUpper(strings.Join(words, " \t\n ")) + "\n "
	ceremony := beginAccount(t, p, recovering, "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": formatted})
	replacement := finishEnrollment(t, p, recovering, ceremony, passkeytest.New(t), "recovery")
	if replacement.Session.Visitor.ID != id || len(replacement.RecoveryCodes) != 1 {
		t.Fatal("recovery lost identity/codes")
	}
	var oldOptions protocol.CredentialCreation
	if err := json.Unmarshal(operatorCeremony.Options, &oldOptions); err != nil {
		t.Fatal(err)
	}
	accountRequest(t, p, recovering, "POST", "/api/accounts/recovery/finish", map[string]any{"ceremonyId": operatorCeremony.ID, "credential": json.RawMessage(passkeytest.New(t).Registration(t, &oldOptions, testOrigin))}, testOrigin, 403)
	accountRequest(t, p, a, "GET", "/api/me", nil, "", 401)
	accountRequest(t, p, a, "GET", "/api/accounts/passkeys", nil, "", 401)
	accountRequest(t, p, a, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": account.RecoveryCodes[0]}, testOrigin, 403)
	accountRequest(t, p, a, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": id, "proof": grant.Token}, testOrigin, 403)
	p.clock.Advance(90 * 24 * time.Hour)
	accountRequest(t, p, recovering, "GET", "/api/me", nil, "", 401)
	for _, code := range append(account.RecoveryCodes, replacement.RecoveryCodes...) {
		if strings.Contains(p.logs.String(), code) {
			t.Fatal("recovery code logged")
		}
	}
}

func TestAccountHTTPRejectsTrailingJSONAndForeignContentType(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	for _, input := range []struct{ body, content string }{{"{} {}", "application/json"}, {"{}", "text/plain"}, {"null", "application/json"}} {
		req, err := http.NewRequestWithContext(t.Context(), "POST", p.srv.URL+"/api/accounts/authentication/begin", strings.NewReader(input.body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", testOrigin)
		req.Header.Set("Content-Type", input.content)
		res, err := browser.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != 400 {
			t.Fatalf("body %q content %q status %d, want 400", input.body, input.content, res.StatusCode)
		}
	}
}

func TestInvitationConcurrentHTTPRedemptionHasOneWinnerAndExpiry(t *testing.T) {
	p := startPublic(t, 100)
	_, a := p.browserWithHTTP(t)
	_, b := p.browserWithHTTP(t)
	invite, err := p.identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ca := beginAccount(t, p, a, "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": "Alice"})
	cb := beginAccount(t, p, b, "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": "Bob"})
	bodies := make([][]byte, 2)
	for i, ceremony := range []wireCeremony{ca, cb} {
		var options protocol.CredentialCreation
		if err := json.Unmarshal(ceremony.Options, &options); err != nil {
			t.Fatal(err)
		}
		bodies[i], err = json.Marshal(map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(passkeytest.New(t).Registration(t, &options, testOrigin))})
		if err != nil {
			t.Fatal(err)
		}
	}
	statuses := make(chan int, 2)
	for i, c := range []*http.Client{a, b} {
		go func() {
			req, err := http.NewRequestWithContext(t.Context(), "POST", p.srv.URL+"/api/accounts/registration/finish", bytes.NewReader(bodies[i]))
			if err != nil {
				statuses <- 0
				return
			}
			req.Header.Set("Origin", testOrigin)
			req.Header.Set("Content-Type", "application/json")
			res, err := c.Do(req)
			if err != nil {
				statuses <- 0
				return
			}
			_ = res.Body.Close()
			statuses <- res.StatusCode
		}()
	}
	first, second := <-statuses, <-statuses
	if first+second != 603 || (first != 200 && second != 200) {
		t.Fatalf("redemption statuses %d/%d", first, second)
	}
	expired, err := p.identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	p.clock.Advance(7 * 24 * time.Hour)
	accountRequest(t, p, a, "POST", "/api/accounts/registration/begin", map[string]any{"invitation": expired.Token, "name": "Expired"}, testOrigin, 403)
}

func TestDisabledStaleAccountRejectedAcrossPublicResolvers(t *testing.T) {
	p := startPublic(t, 100)
	_, a := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	account := enrollAccount(t, p, a, "Alice", key)
	login := beginAccount(t, p, a, "/api/accounts/authentication/begin", map[string]any{})
	var assertion protocol.CredentialAssertion
	if err := json.Unmarshal(login.Options, &assertion); err != nil {
		t.Fatal(err)
	}
	signed := key.Assertion(t, &assertion, testOrigin)
	if _, err := p.identity.DisableAccount(t.Context(), account.Session.Visitor.ID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/me", "/api/rooms", "/api/attachments/limits", "/api/live"} {
		accountRequest(t, p, a, "GET", path, nil, testOrigin, 401)
	}
	accountRequest(t, p, a, "POST", "/api/accounts/authentication/finish", map[string]any{"ceremonyId": login.ID, "credential": json.RawMessage(signed)}, testOrigin, 403)
	accountRequest(t, p, a, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": account.Session.Visitor.ID, "proof": account.RecoveryCodes[0]}, testOrigin, 403)
	guest, _ := p.browserWithHTTP(t)
	p.enter(t, guest, "Visitor")
}

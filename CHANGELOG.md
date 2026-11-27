# Changelog

## [1.3.0](https://github.com/Luckmorecat/falky/compare/v1.2.0...v1.3.0) (2026-11-13)


### Features

* **accounts:** add device approval sign-in ([e0916dc](https://github.com/Luckmorecat/falky/commit/e0916dcb6c0c8d72e411f36cc59d594fbaf06f75))
* **accounts:** add persistent passkey accounts ([cefc48c](https://github.com/Luckmorecat/falky/commit/cefc48c66f50c6db406e5641e9b99a7ef259d0fe))
* **accounts:** add QR and link device sign-in ([6be6e10](https://github.com/Luckmorecat/falky/commit/6be6e1029215d3826ef6f2b7e45ee10ca8e3d70d))
* **api:** expose authenticated chat attachment uploads ([10097ad](https://github.com/Luckmorecat/falky/commit/10097ad23235f87e92d2cb99805047ac33edc435))
* **attachments:** add bounded static image processing ([18358cf](https://github.com/Luckmorecat/falky/commit/18358cf3ddffe533f4ce52289798a0e926a5456b))
* **auth:** show device and IP details for pending sign-ins ([1c356f5](https://github.com/Luckmorecat/falky/commit/1c356f5c04bc9c8017a2bb4257d94390d680669c))
* **chat:** persist attachments with FIFO storage quotas ([0c1cad2](https://github.com/Luckmorecat/falky/commit/0c1cad2ab065c9431c9128aa0bac2c15d0234833))
* **deploy:** add isolated staging branch deployments ([6b303f4](https://github.com/Luckmorecat/falky/commit/6b303f4e8e527b1f3b763bf1be994fceb0a88206))
* **identity:** issue a twelve-word recovery phrase ([98fde3f](https://github.com/Luckmorecat/falky/commit/98fde3f741b6429fde78790410abf57dc2cdb462))
* **mock:** add authenticated account scenario ([b518b56](https://github.com/Luckmorecat/falky/commit/b518b56081143fbb63c8de11cb1a0afa5f433a36))
* **mock:** serve chat attachments in the mock server ([8d02add](https://github.com/Luckmorecat/falky/commit/8d02addc37877c1a1383fea8ddc5eea63d9d2b39))
* **storybook:** add interactive sign-in link flow states ([ebbea71](https://github.com/Luckmorecat/falky/commit/ebbea71109a1f473a325f5999062f5c245ef1143))
* **voice:** expire disconnected grants after ten minutes ([5822418](https://github.com/Luckmorecat/falky/commit/5822418a7c8df2d87c4423b442a54e8001fc2796))
* **voice:** persist grants and centralize recurring jobs ([752e1c6](https://github.com/Luckmorecat/falky/commit/752e1c6eff9f72e4b2c10ce7b1e15caad1471d9a))
* **voice:** preserve grants when leaving voice ([8fe9c14](https://github.com/Luckmorecat/falky/commit/8fe9c14d20a5890427ae981ce051bb585eaf518e))
* **voice:** support independent connections per session ([75e05f7](https://github.com/Luckmorecat/falky/commit/75e05f712ac698c559a8b8bd846d634b19abde8e))
* **web:** add Beacon cues for unread chat ([d62f8d6](https://github.com/Luckmorecat/falky/commit/d62f8d615535690cf4bf5c77a0b5ce90d8977d56))
* **web:** add passkey account entry and settings ([c438622](https://github.com/Luckmorecat/falky/commit/c4386229947b136717f4cd4ddef8b8f5d8c10cd9))
* **web:** center OTP slots above sign-in approval ([74687d0](https://github.com/Luckmorecat/falky/commit/74687d08641c5c9ca1674b2638e02c723e86a844))
* **web:** move sign-in link approval into a bottom drawer ([b580b61](https://github.com/Luckmorecat/falky/commit/b580b61f714fec795d8d3200d220b30018cccad1))
* **web:** send and view images in the chat ([5d48df3](https://github.com/Luckmorecat/falky/commit/5d48df3a105fa046cd910397db6a82a58d3b8126))


### Bug Fixes

* **accounts:** address device approval review findings ([f5c06cc](https://github.com/Luckmorecat/falky/commit/f5c06ccecac701f64ec2bc2a31ad08a4f633ea8a))
* **accounts:** preserve device sign-in retries and lifecycle ([7f0f74a](https://github.com/Luckmorecat/falky/commit/7f0f74a5a7182cdfa772bffb27bc90692eb116ac))
* **accounts:** preserve replacement link allocations ([41b6492](https://github.com/Luckmorecat/falky/commit/41b6492ce0af1eb964b68a3b517d5c01bee1bd70))
* **accounts:** recover QR sign-in retries ([6358778](https://github.com/Luckmorecat/falky/commit/635877801855bc8aaf15eec365863bdf28815625))
* **accounts:** recover uncertain sign-in after expiry ([522928b](https://github.com/Luckmorecat/falky/commit/522928b1f56df370b0e312c472909e30d5e37b22))
* **accounts:** retain committed credentials on cleanup failure ([fe1e7bd](https://github.com/Luckmorecat/falky/commit/fe1e7bdf6d74a0a4eaf5b97d70fe129d1eb3256b))
* **accounts:** reuse one area for temporary sign-in links ([a2b4ff8](https://github.com/Luckmorecat/falky/commit/a2b4ff8f13006865e3e7813605ee399ccd121248))
* **accounts:** secure device approval and split history cleanup ([ae7261a](https://github.com/Luckmorecat/falky/commit/ae7261abf575cb1413777ecd69d926593bdb4242))
* **accounts:** stop polling rejected sign-in links ([068c33d](https://github.com/Luckmorecat/falky/commit/068c33d4d7556fcf455135ef71dbfdaed8f78411))
* **accounts:** stop polling revoked sign-in links ([fe6d5c9](https://github.com/Luckmorecat/falky/commit/fe6d5c9aaf3a1d146c58c8b46eea9dc3cc2f2ee8))
* **attachments:** preserve metadata lookup across retries ([e6a946b](https://github.com/Luckmorecat/falky/commit/e6a946bc8d3aa927ff9132c0d4943bb90589aead))
* **build:** upgrade Go to 1.27.4 for security fixes ([fe5430a](https://github.com/Luckmorecat/falky/commit/fe5430a824a14b8e6655edb26cf5c5a60e18f0d0))
* **deploy:** accept staging frontend build metadata ([787f55a](https://github.com/Luckmorecat/falky/commit/787f55a8f5b70c0d7b2b0acee2f87d328cb04910))
* **identity:** accept passkeys without optional credProps ([ae39721](https://github.com/Luckmorecat/falky/commit/ae3972140ae6a4cccec9251878c13462203f0dbc))
* **identity:** unify sessions and preserve guest voice ([5485727](https://github.com/Luckmorecat/falky/commit/5485727cca1c530629dd26b3240ef79468ab01b3))
* **platform:** charge related quotas atomically ([865d253](https://github.com/Luckmorecat/falky/commit/865d25321ebd457017b2e3a12108d031e0191865))
* **test:** give device request IP test a context ([f525bd6](https://github.com/Luckmorecat/falky/commit/f525bd6950a27471c281b27ff6c30fab6e6852f8))
* **web:** allow blob images in the content security policy ([9249909](https://github.com/Luckmorecat/falky/commit/9249909109783536105d90282511b89ad346a4fc))
* **web:** keep QR scanner above settings with delayed skeleton ([8d54e3a](https://github.com/Luckmorecat/falky/commit/8d54e3aeac8dc1d5f3b5846a3ba3dcd2b6dcb927))
* **web:** land the closing lightbox picture on its thumbnail ([ecff894](https://github.com/Luckmorecat/falky/commit/ecff894dfec098c8d4e7ff8995e06274492fc598))
* **web:** match superellipse corners in Safari ([268da58](https://github.com/Luckmorecat/falky/commit/268da5843c2f08974a4fe37c4e938c931006864c))
* **web:** preserve drawer padding clicks and highlight code entry ([941de26](https://github.com/Luckmorecat/falky/commit/941de26a0a67b0b25c59d8f03c8429ed80c09754))
* **web:** put device sign-in first in account settings ([bbd73f5](https://github.com/Luckmorecat/falky/commit/bbd73f5bd05417286c483df59b1e6719a423d59e))
* **web:** simplify account actions and improve form spacing ([7e8ddf0](https://github.com/Luckmorecat/falky/commit/7e8ddf0495dca20e087ef177f237f8a7a6296e9a))
* **web:** stop playing a sound on hover ([da25fe9](https://github.com/Luckmorecat/falky/commit/da25fe9cc32075ea6558be0762fe8bc6d608c204))
* **web:** suppress auth dialog focus outline ([4f9cfa4](https://github.com/Luckmorecat/falky/commit/4f9cfa44a617fc4663cd37728157ad631ddfd884))


### Performance Improvements

* **attachments:** use browser caching with ETags ([36ee4d0](https://github.com/Luckmorecat/falky/commit/36ee4d02a0d0296d7dff3de1f45f1fae10217302))
* **identity:** remove redundant sign-in indexes ([50c3768](https://github.com/Luckmorecat/falky/commit/50c376894b6dba953791f43b0d4c990def67b06c))

## [1.2.0](https://github.com/Luckmorecat/falky/compare/v1.1.0...v1.2.0) (2026-11-08)


### Features

* **chat:** distinguish your messages with alignment and tint ([5dfcb2a](https://github.com/Luckmorecat/falky/commit/5dfcb2a3e2afe8e0231b82e51655dc4791774b58))
* **profile:** share persistent visitor colours ([d283f9a](https://github.com/Luckmorecat/falky/commit/d283f9a256f5229a836d565de5e6b6b9a08ea81d))
* **storybook:** add interactive orb stories and size controls ([8ec59e7](https://github.com/Luckmorecat/falky/commit/8ec59e726381c78ecd745e0f318fe7ce18434cba))
* **ui:** add a live background with colliding theme currents ([2a977d3](https://github.com/Luckmorecat/falky/commit/2a977d3ab7293d814a3e4b457e835b9abe6c3ecc))
* **ui:** add an opt-in voice-reactive background ([845ba60](https://github.com/Luckmorecat/falky/commit/845ba60454a5fccd0934a0aedbf49d2a03416d6a))
* **ui:** reveal keyboard shortcuts in tooltips ([d22e52a](https://github.com/Luckmorecat/falky/commit/d22e52ab12c63a6ad764360cfccd3272a701e4d0))
* **web:** add mock memory profiling command ([397ceef](https://github.com/Luckmorecat/falky/commit/397ceefda9ca1d9eff938f5b1d064508bae56582))
* **web:** add repeatable JSON performance profiling ([d583db4](https://github.com/Luckmorecat/falky/commit/d583db45583aede2f16de74871267ea706efb42e))
* **web:** add wheel volume control across participant tiles ([785c50a](https://github.com/Luckmorecat/falky/commit/785c50ab1798991e346209bdb6308328b6394a77))
* **web:** camera, one corner shape everywhere and bubbling sounds ([fc79390](https://github.com/Luckmorecat/falky/commit/fc793901e82a68248e80a876d8cda1532f57a516)), refs [#10](https://github.com/Luckmorecat/falky/issues/10) [#14](https://github.com/Luckmorecat/falky/issues/14)
* **web:** report memory above a blank-tab baseline ([d5d5a76](https://github.com/Luckmorecat/falky/commit/d5d5a76fa05c3d47e38b1a2eeaf5ea0c65cba3cf))
* **web:** show the loaded build version in the UI ([5607e94](https://github.com/Luckmorecat/falky/commit/5607e94c7d969ee4bf9832086414e40581f721b7))
* **web:** show when a participant is muted for you ([18f0f54](https://github.com/Luckmorecat/falky/commit/18f0f54292eda6855148ed07566b932d651ba726))
* **web:** turn settings into a tabbed window with favourite colours ([1ce2fd1](https://github.com/Luckmorecat/falky/commit/1ce2fd11b8a83fb0f51a53e069c4e1735a39e105))


### Bug Fixes

* **web:** preserve settings layout while closing ([b05c0bf](https://github.com/Luckmorecat/falky/commit/b05c0bfae02122481b7b5a6ef9c52b438ccee30e))
* **web:** remember the chat reading place per room ([bed5eaa](https://github.com/Luckmorecat/falky/commit/bed5eaaf85a977b0a33a4aa0cacfa485b9587ba3))
* **web:** remove seams from orb grain ([2cee5b4](https://github.com/Luckmorecat/falky/commit/2cee5b4bc5b3dea224d6416fcf0cc81c062c9062))
* **web:** return 404 for missing static files ([e8de234](https://github.com/Luckmorecat/falky/commit/e8de234a21e2284aa5cc918d046fb51431e6345c))
* **web:** show the build version only on the main screen ([93d4488](https://github.com/Luckmorecat/falky/commit/93d448860cbcfa3a1ab24eb5958e53dc7138ebc0))
* **web:** toggle screen-share fullscreen ([b2bc4a7](https://github.com/Luckmorecat/falky/commit/b2bc4a7ad3c58cff1ef66ef142bbd26ad0d1cdc7))


### Performance Improvements

* **web:** avoid redundant background and chat startup work ([9cab2e5](https://github.com/Luckmorecat/falky/commit/9cab2e5e78382da8945705d625807c5eacd83188))
* **web:** compress static responses with gzip and zstd ([25b2162](https://github.com/Luckmorecat/falky/commit/25b21626598b63b94fc4d38e9edbfd346225aae3))
* **web:** defer LiveKit and settings loading ([577a4d6](https://github.com/Luckmorecat/falky/commit/577a4d6c01a45bde6810a3534a8357917154ef9c))

## [1.1.0](https://github.com/Luckmorecat/falky/compare/v1.0.0...v1.1.0) (2026-11-06)


### Features

* **web:** add isolated local mock development mode ([412f703](https://github.com/Luckmorecat/falky/commit/412f703f9fb909532c8abe524db7c35df0106bb5))
* **web:** add mock screenshot presets and GPU option ([8fbc327](https://github.com/Luckmorecat/falky/commit/8fbc327a95837327febd6518857eda78217ad18e))


### Bug Fixes

* **deploy:** separate application releases from VPS infrastructure ([6fe2454](https://github.com/Luckmorecat/falky/commit/6fe245425b366bcb30f6bd23c5a85c238b5b0e35))

## 1.0.0 (2026-11-05)


### Features

* **deploy:** automate VPS deployment after image publication ([2d8d5e8](https://github.com/Luckmorecat/falky/commit/2d8d5e84bbb779e02093b26583b5e61bd531045a))
* **deploy:** Caddy serves the web client, make check covers it ([aea7926](https://github.com/Luckmorecat/falky/commit/aea7926a8beb6f7e7285b63700c9ee8686eb3eee))
* **deploy:** deploy published server and web images ([651ad9d](https://github.com/Luckmorecat/falky/commit/651ad9d519b7fd6863e8f766b5cb7d4c4e8d32dc))
* **deploy:** one-host Compose stack with Caddy, LiveKit and the server ([c48cb5c](https://github.com/Luckmorecat/falky/commit/c48cb5c529c61d6074e029a2284d14d65eccddfe))
* **deploy:** publish and update only changed application images ([9afd179](https://github.com/Luckmorecat/falky/commit/9afd17919419713c62600ee25ca5f55bc05ac787))
* **deploy:** retain the ten newest completed backups ([0439942](https://github.com/Luckmorecat/falky/commit/043994219fe8ead94adf3d4ead8b6e2c7f8c289d))
* **deploy:** separate development and tagged production releases ([4abbd91](https://github.com/Luckmorecat/falky/commit/4abbd91645c0cd96862293fa35367c0ecc6d3587))
* **server:** admin socket, first access link and falky link show ([7aa14a0](https://github.com/Luckmorecat/falky/commit/7aa14a0e9df0e1d74971bd880e650ed490048c9f))
* **server:** connected visitors hold their names ([c8dfa62](https://github.com/Luckmorecat/falky/commit/c8dfa628c394796cdabf3feb20aa6226a2f8e4c9))
* **server:** database snapshots, checked restore and the runbook ([14e42a5](https://github.com/Luckmorecat/falky/commit/14e42a532cb03ff5c478553edd98ab2069ce73f4))
* **server:** end-to-end smoke check of the local Compose stack ([6b9fe6b](https://github.com/Luckmorecat/falky/commit/6b9fe6b02e38ee67aa877da96a49d3f0a0f88430))
* **server:** enter with the access link, visitor cookie and names ([a325e7d](https://github.com/Luckmorecat/falky/commit/a325e7d5926ff09f425f0f31ff7de3cf81af2f00))
* **server:** link rotation ends every access of the old link ([38f5b38](https://github.com/Luckmorecat/falky/commit/38f5b38edd84220c17bfa1aa399c06c0e87af886))
* **server:** live updates over a WebSocket hub ([ca8fed6](https://github.com/Luckmorecat/falky/commit/ca8fed67e7479aad33925d7cf3b28a43cfd6f6bd))
* **server:** occupancy from LiveKit webhooks and refresh ([ca8b346](https://github.com/Luckmorecat/falky/commit/ca8b346c36883d8c08b293a03f841e6862f67caf))
* **server:** room chat with idempotent posting and history ([8c0e400](https://github.com/Luckmorecat/falky/commit/8c0e40092f148e4bb5890e532aa70be08814c55f))
* **server:** rooms, falky room create/rename and the room list ([56b2190](https://github.com/Luckmorecat/falky/commit/56b2190c7865a70815cae634449f767e7eb82c0b))
* **server:** scaffold serve/migrate, SQLite, health, metrics and contract ([5619f71](https://github.com/Luckmorecat/falky/commit/5619f71190e29116024d7df7a537353ec168eaf3))
* **server:** voice join with LiveKit tokens, cap and room moves ([177a8ed](https://github.com/Luckmorecat/falky/commit/177a8ed05af61ce0ee44219c0dcc9a4a98b44fe2))
* **web:** add screen share bitrate multiplier ([f3db26c](https://github.com/Luckmorecat/falky/commit/f3db26c6c79a99acfb913bbf8034493609e56618))
* **web:** add screen share codec selection ([b5e5531](https://github.com/Luckmorecat/falky/commit/b5e5531f734c6f04c680c8d4e28e38d4d195c457))
* **web:** gate screen share stats with an environment flag ([ede0d54](https://github.com/Luckmorecat/falky/commit/ede0d54110c84309616e1a31b46c6732b9a7b0fd))
* **web:** orbs, the top room switcher and a chat at the page's edge ([ceb5775](https://github.com/Luckmorecat/falky/commit/ceb57754cd68eb1f9beedd2cdc94c0a31ba82dc5))
* **web:** raise a participant's voice up to 200% ([a66ef87](https://github.com/Luckmorecat/falky/commit/a66ef87d3831ad6bdcdb8ac29c9361fe68f9fd09))
* **web:** show dev screen share bitrate and codec stats ([4b8385c](https://github.com/Luckmorecat/falky/commit/4b8385c685295ebc1dced2387a283c6889b414a1))
* **web:** the browser client ([50b4c02](https://github.com/Luckmorecat/falky/commit/50b4c02ac22dd92f722be0e7bed664febbc7cb04))


### Bug Fixes

* **deploy:** always publish both images for version tags ([22c1786](https://github.com/Luckmorecat/falky/commit/22c17869f39c31fa061d89c5ab593f14f1dda7c0))
* **deploy:** protect retained data and wait for backup locks ([dc06a4f](https://github.com/Luckmorecat/falky/commit/dc06a4fdad48171d20437ddbe7d83db58c29a20c))
* **deploy:** select instance volumes in recovery instructions ([a5b952f](https://github.com/Luckmorecat/falky/commit/a5b952fe9387c5ab828c956a27192ad9cfcb2bac))
* **deploy:** update only the published component ([f5c5d65](https://github.com/Luckmorecat/falky/commit/f5c5d65ee1525e27dfa4d0636b9fe8ad8bff3221))
* **deploy:** verify shared host configuration before releasing ([46cf9b0](https://github.com/Luckmorecat/falky/commit/46cf9b0042ff602f056298320568c27240ee619b))
* **server:** name conflicts count only connected visitors ([3f00809](https://github.com/Luckmorecat/falky/commit/3f00809a56330e9d95abfdb94604477a5267a833))

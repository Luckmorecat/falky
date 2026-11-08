# Changelog

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

# Changelog

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

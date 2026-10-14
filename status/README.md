# status/

- `xpd-status.js` — a tiny, dependency-free ES module that shows the publish state of the site
  (`/_deploy/live.json`, `meta.json`, `pull.json`). Copy it into your site and call `mount(el, { repo, lang })`.
- `schema/` — JSON Schemas of the three status files.

Documentation (Japanese): [docs/ja/status.md](../docs/ja/status.md).

```html
<div id="xpd-status"></div>
<script type="module">
  import { mount } from '/xpd-status.js';
  mount(document.getElementById('xpd-status'), { repo: 'your-org/your-site', lang: 'en' });
</script>
```

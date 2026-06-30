(function() {
  if (window.__helitakScraperRunning) { return; }
  window.__helitakScraperRunning = true;

  const origin = location.origin;
  const visited = new Set();
  const queue = [];
  const files = new Map();
  const logLines = [];
  let rawFrames = [];       // every socket.io frame, verbatim
  let parsedEvents = [];    // every parsed {event, args, time}
  let capturing = false;
  let liveValues = new Map(); // Id -> {value, count, firstSeen, lastSeen}

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:8px;right:8px;width:360px;max-height:92vh;overflow:auto;background:#10131a;color:#e8e6df;font:12px/1.4 monospace;z-index:999999999;border:1px solid #444;border-radius:10px;padding:10px;box-shadow:0 4px 20px rgba(0,0,0,.6)';
  panel.innerHTML =
    '<div style="font-weight:bold;font-size:13px;margin-bottom:6px">Helitak HMI Scraper v3</div>' +
    '<div style="margin-bottom:6px">' +
      '<button id="hk-start" style="padding:6px 10px;margin-right:4px">Crawl assets</button>' +
      '<button id="hk-snapshot" style="padding:6px 10px;margin-right:4px">Snapshot DOM/storage</button>' +
    '</div>' +
    '<div style="margin-bottom:6px">' +
      'Capture (s): <input id="hk-secs" type="number" value="30" style="width:50px;background:#000;color:#fff;border:1px solid #333;border-radius:4px">' +
      ' <button id="hk-capture" style="padding:6px 10px;margin-left:4px">Capture live</button>' +
    '</div>' +
    '<div id="hk-status" style="margin-bottom:6px;color:#9fe1cb">Idle.</div>' +
    '<div style="font-weight:bold;margin-bottom:4px">Live Id &rarr; Value (sorted)</div>' +
    '<div id="hk-table" style="height:160px;overflow:auto;background:#000;padding:4px;border-radius:6px;margin-bottom:6px;white-space:pre"></div>' +
    '<div id="hk-log" style="height:110px;overflow:auto;background:#000;padding:4px;border-radius:6px;margin-bottom:6px;white-space:pre-wrap"></div>' +
    '<textarea id="hk-notes" placeholder="Notes / observed values (e.g. screen shows 266 kPa at this moment)..." style="width:100%;height:60px;background:#000;color:#fc7;border:1px solid #333;border-radius:6px;padding:4px;box-sizing:border-box"></textarea>' +
    '<div style="margin-top:6px">' +
      '<button id="hk-export" style="padding:6px 10px;margin-right:4px">Export ZIP</button>' +
      '<button id="hk-close" style="padding:6px 10px">Close</button>' +
    '</div>';
  document.body.appendChild(panel);

  const statusEl = panel.querySelector('#hk-status');
  const logEl = panel.querySelector('#hk-log');
  const tableEl = panel.querySelector('#hk-table');

  function log(msg) {
    logLines.push('[' + new Date().toISOString() + '] ' + msg);
    logEl.textContent = logLines.slice(-300).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(msg) { statusEl.textContent = msg; }

  function renderTable() {
    const rows = Array.from(liveValues.entries()).sort(function(a, b) {
      return String(a[0]).localeCompare(String(b[0]));
    });
    tableEl.textContent = rows.map(function(r) {
      return r[0] + '  =  ' + r[1].value + '   (x' + r[1].count + ')';
    }).join('\n');
  }

  panel.querySelector('#hk-close').onclick = function() {
    panel.remove();
    window.__helitakScraperRunning = false;
  };

  function isSameOrigin(url) {
    try { return new URL(url, location.href).origin === origin; } catch (e) { return false; }
  }

  function pathFor(url) {
    const u = new URL(url, location.href);
    let p = u.pathname + (u.search || '');
    if (p.endsWith('/')) p += 'index.html';
    return p.replace(/^\//, '');
  }

  async function fetchAndStore(url) {
    const path = pathFor(url);
    if (files.has(path)) return null;
    try {
      const res = await fetch(url, { credentials: 'omit' });
      const ct = res.headers.get('content-type') || '';
      const isText = /text|javascript|json|html|css|xml|svg/.test(ct) ||
        /\.(html|js|css|json|txt|svg|map)(\?|$)/i.test(url);
      if (isText) {
        const text = await res.text();
        files.set(path, { isText: true, text: text });
        return { path: path, isText: true, text: text };
      } else {
        const blob = await res.blob();
        files.set(path, { isText: false, blob: blob });
        return { path: path, isText: false, blob: blob };
      }
    } catch (e) {
      log('FAIL ' + url + ' :: ' + e.message);
      return null;
    }
  }

  // Pull links from href/src attrs, CSS url()/@import, and plausible asset
  // string literals inside JS (e.g. fetch("/api/..."), "/socket.io/...", etc.)
  function extractLinks(text, baseUrl) {
    const found = new Set();
    const attrRe = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    const cssUrlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    const cssImportRe = /@import\s+["']([^"']+)["']/gi;
    const jsPathRe = /["'](\/[a-zA-Z0-9_\-./]+\.(?:js|css|json|html|svg|png|jpg|jpeg|gif|ico|woff2?|map))["']/gi;
    const apiPathRe = /["'](\/(?:api|socket\.io|ws)[a-zA-Z0-9_\-./?=&]*)["']/gi;
    [attrRe, cssUrlRe, cssImportRe, jsPathRe, apiPathRe].forEach(function(re) {
      let m;
      while ((m = re.exec(text))) {
        try {
          const abs = new URL(m[1], baseUrl).href;
          if (isSameOrigin(abs) && abs.indexOf('#') === -1) found.add(abs.split('#')[0]);
        } catch (e) {}
      }
    });
    return Array.from(found);
  }

  async function crawl(startUrl, maxPages) {
    queue.push(startUrl);
    visited.add(startUrl);
    let count = 0;
    while (queue.length && count < maxPages) {
      const url = queue.shift();
      count++;
      setStatus('Fetching (' + count + '/' + maxPages + '): ' + url.replace(origin, ''));
      const result = await fetchAndStore(url);
      log((result ? 'OK   ' : 'SKIP ') + url.replace(origin, ''));
      if (result && result.isText) {
        const links = extractLinks(result.text, url);
        for (let i = 0; i < links.length; i++) {
          const l = links[i];
          if (!visited.has(l)) { visited.add(l); queue.push(l); }
        }
      }
    }
    // Also pull in anything the browser already loaded (perf entries) that we missed
    try {
      performance.getEntriesByType('resource').forEach(function(r) {
        if (isSameOrigin(r.name) && !visited.has(r.name)) {
          visited.add(r.name);
          queue.push(r.name);
        }
      });
      while (queue.length) {
        const url = queue.shift();
        const result = await fetchAndStore(url);
        log((result ? 'OK   ' : 'SKIP ') + '(perf) ' + url.replace(origin, ''));
      }
    } catch (e) { log('perf scan failed: ' + e.message); }

    setStatus('Crawl complete: ' + files.size + ' files captured.');
    log('=== Crawl complete: ' + files.size + ' files ===');
  }

  panel.querySelector('#hk-start').onclick = function() {
    log('Starting crawl from ' + location.href);
    crawl(location.href, 150);
  };

  panel.querySelector('#hk-snapshot').onclick = function() {
    try {
      files.set('_snapshot/dom.html', { isText: true, text: document.documentElement.outerHTML });
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        ls[k] = localStorage.getItem(k);
      }
      const ss = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        ss[k] = sessionStorage.getItem(k);
      }
      files.set('_snapshot/localStorage.json', { isText: true, text: JSON.stringify(ls, null, 2) });
      files.set('_snapshot/sessionStorage.json', { isText: true, text: JSON.stringify(ss, null, 2) });
      files.set('_snapshot/cookies.txt', { isText: true, text: document.cookie });
      const perf = performance.getEntriesByType('resource').map(function(r) {
        return { name: r.name, type: r.initiatorType, duration: r.duration, transferSize: r.transferSize };
      });
      files.set('_snapshot/performance_resources.json', { isText: true, text: JSON.stringify(perf, null, 2) });
      log('Snapshot captured: DOM, storage, cookies, perf resources.');
      setStatus('Snapshot saved (' + files.size + ' files total).');
    } catch (e) {
      log('Snapshot failed: ' + e.message);
    }
  };

  // Parse any socket.io 1.x frame type, not just "data" events.
  // Frame layout: "<type>:<id>:<endpoint>:<json-or-text>"
  // type 3 = message, 4 = json, 5 = event ({"name":...,"args":[...]})
  function parseFrame(msg) {
    if (typeof msg !== 'string') return;
    rawFrames.push(msg);

    const parts = msg.split(':');
    const type = parts[0];
    let payload = msg.slice(msg.indexOf(':', msg.indexOf(':', 2) + 1) + 1);
    // fallback: just grab from first '{' if split heuristic fails
    const jsonStart = msg.indexOf('{');

    if (type === '5' && jsonStart !== -1) {
      let outer;
      try { outer = JSON.parse(msg.slice(jsonStart)); } catch (e) { return; }
      if (!outer || !outer.name) return;
      const eventName = outer.name;
      let argsRaw = outer.args && outer.args[0];
      let tags = argsRaw;
      if (typeof argsRaw === 'string') {
        try { tags = JSON.parse(argsRaw); } catch (e) { /* leave as string */ }
      }
      parsedEvents.push({ time: new Date().toISOString(), event: eventName, args: tags });

      if (eventName === 'data' && Array.isArray(tags)) {
        const now = new Date().toISOString();
        tags.forEach(function(t) {
          if (t == null || t.Id == null) return;
          const prev = liveValues.get(t.Id);
          liveValues.set(t.Id, {
            value: t.Value,
            count: prev ? prev.count + 1 : 1,
            firstSeen: prev ? prev.firstSeen : now,
            lastSeen: now
          });
        });
        renderTable();
      } else {
        log('EVT[' + eventName + ']: ' + JSON.stringify(tags).slice(0, 120));
      }
    } else if (type === '4' && jsonStart !== -1) {
      try { parsedEvents.push({ time: new Date().toISOString(), event: '(json)', args: JSON.parse(msg.slice(jsonStart)) }); } catch (e) {}
    } else if (type === '3') {
      parsedEvents.push({ time: new Date().toISOString(), event: '(message)', args: payload });
    }
  }

  panel.querySelector('#hk-capture').onclick = function() {
    if (capturing) return;
    capturing = true;
    rawFrames = [];
    parsedEvents = [];
    liveValues = new Map();
    renderTable();
    const secs = Math.max(5, parseInt(panel.querySelector('#hk-secs').value, 10) || 30);
    setStatus('Capturing live socket data for ' + secs + 's...');
    log('=== Starting live capture (' + secs + 's) ===');

    const handshakeUrl = origin + '/socket.io/1/?t=' + Date.now();
    fetch(handshakeUrl).then(function(r) { return r.text(); }).then(function(body) {
      rawFrames.push('[handshake] ' + body);
      const sid = body.split(':')[0];
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = wsProto + '://' + location.host + '/socket.io/1/websocket/' + sid;
      const ws = new WebSocket(wsUrl);
      ws.onopen = function() {
        ws.send('1::');
        log('WS OPEN');
      };
      ws.onmessage = function(ev) {
        const msg = ev.data;
        if (msg === '2::') { ws.send('2::'); return; }
        log('LIVE: ' + msg.slice(0, 100));
        parseFrame(msg);
      };
      ws.onerror = function() { log('WS error'); };
      ws.onclose = function() { log('WS closed'); };
      setTimeout(function() {
        ws.close();
        capturing = false;
        setStatus('Live capture done: ' + rawFrames.length + ' frames, ' +
          parsedEvents.length + ' events, ' + liveValues.size + ' unique Ids.');
        log('=== Live capture done ===');
      }, secs * 1000);
    }).catch(function(e) {
      log('Handshake failed: ' + e.message);
      capturing = false;
    });
  };

  panel.querySelector('#hk-export').onclick = async function() {
    setStatus('Loading zip library...');
    if (!window.JSZip) {
      await new Promise(function(resolve, reject) {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    setStatus('Building zip...');
    const zip = new JSZip();

    files.forEach(function(data, path) {
      if (data.isText) zip.file(path, data.text);
      else zip.file(path, data.blob);
    });

    const notes = panel.querySelector('#hk-notes').value;

    zip.file('crawl_log.txt', logLines.join('\n'));
    zip.file('manual_notes.txt', notes);

    if (rawFrames.length) {
      zip.file('socketio_raw_frames.txt', rawFrames.join('\n'));
    }
    if (parsedEvents.length) {
      zip.file('socketio_parsed_events.json', JSON.stringify(parsedEvents, null, 2));
    }
    if (liveValues.size) {
      const rows = Array.from(liveValues.entries()).sort(function(a, b) {
        return String(a[0]).localeCompare(String(b[0]));
      });
      const tableTxt = rows.map(function(r) {
        return r[0] + ' = ' + r[1].value + ' (seen x' + r[1].count +
          ', first ' + r[1].firstSeen + ', last ' + r[1].lastSeen + ')';
      }).join('\n');
      zip.file('live_id_value_table.txt', tableTxt);
      zip.file('live_id_value_table.json', JSON.stringify(rows.map(function(r) {
        return { id: r[0], value: r[1].value, count: r[1].count, firstSeen: r[1].firstSeen, lastSeen: r[1].lastSeen };
      }), null, 2));
    }

    setStatus('Generating download...');
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'helitak_scrape_' + Date.now() + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('Exported ' + files.size + ' files as zip.');
    log('=== Export complete ===');
  };
})();

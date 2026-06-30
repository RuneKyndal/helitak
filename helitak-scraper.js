(function() {
  if (window.__helitakScraperRunning) { return; }
  window.__helitakScraperRunning = true;

  const origin = location.origin;
  const visited = new Set();
  const queue = [];
  const files = new Map();
  const logLines = [];
  let liveCaptureLines = [];
  let capturing = false;

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:8px;right:8px;width:300px;max-height:90vh;overflow:auto;background:#10131a;color:#e8e6df;font:12px/1.4 monospace;z-index:999999999;border:1px solid #444;border-radius:10px;padding:10px;box-shadow:0 4px 20px rgba(0,0,0,.6)';
  panel.innerHTML = '<div style="font-weight:bold;font-size:13px;margin-bottom:6px">Helitak HMI Scraper</div>' +
    '<div style="margin-bottom:6px">' +
    '<button id="hk-start" style="padding:6px 10px;margin-right:4px">Start crawl</button>' +
    '<button id="hk-capture" style="padding:6px 10px;margin-right:4px">Capture live (10s)</button>' +
    '</div>' +
    '<div id="hk-status" style="margin-bottom:6px;color:#9fe1cb">Idle.</div>' +
    '<div id="hk-log" style="height:140px;overflow:auto;background:#000;padding:4px;border-radius:6px;margin-bottom:6px;white-space:pre-wrap"></div>' +
    '<textarea id="hk-notes" placeholder="Notes / observed values..." style="width:100%;height:70px;background:#000;color:#fc7;border:1px solid #333;border-radius:6px;padding:4px;box-sizing:border-box"></textarea>' +
    '<div style="margin-top:6px">' +
    '<button id="hk-export" style="padding:6px 10px;margin-right:4px">Export ZIP</button>' +
    '<button id="hk-close" style="padding:6px 10px">Close</button>' +
    '</div>';
  document.body.appendChild(panel);

  const statusEl = panel.querySelector('#hk-status');
  const logEl = panel.querySelector('#hk-log');
  function log(msg) {
    logLines.push(msg);
    logEl.textContent = logLines.slice(-200).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(msg) { statusEl.textContent = msg; }

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
      const isText = /text|javascript|json|html|css|xml/.test(ct) || /\.(html|js|css|json|txt)(\?|$)/i.test(url);
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

  function extractLinks(html, baseUrl) {
    const found = new Set();
    const attrRe = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = attrRe.exec(html))) {
      try {
        const abs = new URL(m[1], baseUrl).href;
        if (isSameOrigin(abs) && abs.indexOf('#') === -1) found.add(abs.split('#')[0]);
      } catch (e) {}
    }
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
    setStatus('Crawl complete: ' + files.size + ' files captured.');
    log('=== Crawl complete: ' + files.size + ' files ===');
  }

  panel.querySelector('#hk-start').onclick = function() {
    log('Starting crawl from ' + location.href);
    crawl(location.href, 60);
  };

  panel.querySelector('#hk-capture').onclick = function() {
    if (capturing) return;
    capturing = true;
    liveCaptureLines = [];
    setStatus('Capturing live socket data for 10s...');
    log('=== Starting live capture ===');

    const handshakeUrl = origin + '/socket.io/1/?t=' + Date.now();
    fetch(handshakeUrl).then(function(r) { return r.text(); }).then(function(body) {
      liveCaptureLines.push('[handshake] ' + body);
      const sid = body.split(':')[0];
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = wsProto + '://' + location.host + '/socket.io/1/websocket/' + sid;
      const ws = new WebSocket(wsUrl);
      ws.onopen = function() {
        ws.send('1::');
        liveCaptureLines.push('[' + new Date().toISOString() + '] OPEN');
      };
      ws.onmessage = function(ev) {
        const msg = ev.data;
        if (msg === '2::') { ws.send('2::'); return; }
        liveCaptureLines.push('[' + new Date().toISOString() + '] ' + msg);
        log('LIVE: ' + msg.slice(0, 80));
      };
      ws.onerror = function() { log('WS error'); };
      setTimeout(function() {
        ws.close();
        capturing = false;
        setStatus('Live capture done: ' + liveCaptureLines.length + ' lines.');
        log('=== Live capture done ===');
      }, 10000);
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
    let notesOut = '=== Crawl log ===\n' + logLines.join('\n') + '\n\n';
    notesOut += '=== Manual notes ===\n' + notes + '\n\n';
    if (liveCaptureLines.length) {
      notesOut += '=== Live socket capture ===\n' + liveCaptureLines.join('\n') + '\n';
    }
    zip.file('notes.txt', notesOut);

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

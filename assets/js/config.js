/* ════════════════════════════════════════════════════════════════════
   App configuration — the ONLY place URLs live.
   Note: anything shipped to a browser can be seen by a determined visitor, so the
   backend URL is not a secret. What protects the data is the backend itself:
   trainer actions need a signed login token, supervisor actions are scoped to
   their own pharmacists, and the Google Sheet stays private.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  const cfg = {
    // Google Apps Script web app that reads/writes the app's Google Sheet (the CURRENT live backend)
    API_URL: 'https://script.google.com/macros/s/AKfycbxbLEHU-uRJhHtd9yT2nqiFi6trJEyvNS8zxKNkALhY_deI5U9VlrKF5AJJUsbPvSyU/exec',
    API_KIND: 'gas',   // 'gas' (Google Apps Script) | 'supabase' — chosen below

    // Supabase backend (the faster replacement). The anon key is public by design; it only lets a caller
    // REACH the Edge Function — all real auth (trainer token / supervisor scoping) is enforced server-side,
    // and Row-Level Security blocks the anon key from touching any table directly.
    SUPABASE_URL: 'https://aoqgabdsayaqgqroscdw.supabase.co',
    SUPABASE_ANON: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvcWdhYmRzYXlhcWdxcm9zY2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNzI5NzYsImV4cCI6MjEwNTY0ODk3Nn0.xJ_aTcn6XtYbQGRi_DjlczgVRG7JV5gpi7RYwUxOH4s',

    // Existing LMS completion-report source (used by Trainer > Setup > "Sync Now")
    COMPLETION_REPORTS_URL: 'https://script.google.com/macros/s/AKfycbzLmYSVLykZNjjYKWeWxhJOlsHoDNKzxlGH8zg931_rr6y4VHTPxqNVj5W7zFvWNTuS/exec',

    // Landing-page cards
    LINKS: {
      progressReports: 'https://upc-talent.github.io/LMS-reporting/'
      // LMS Ticketing System card is switched off for now. To bring it back: add this link here
      //   ticketing: 'https://forms.clickup.com/90152546261/f/2kyr5byn-5335/DH1J7W33E380VYJM8C'
      // and re-add the card (see the "c-ticket" style in assets/css/app.css) to index.html.
    },

    BASE: ''   // path prefix for dev helpers (leave empty)
  };

  // Backend selection.
  //   ?backend=supabase  → use the Supabase Edge Function (and remember it for this tab)
  //   ?backend=gas       → go back to the Google Apps Script backend
  // Until you flip it, the app keeps using Google Apps Script, so nothing changes for live users while we test.
  try {
    const b = new URLSearchParams(location.search).get('backend');
    if (b === 'supabase') sessionStorage.setItem('upc_backend', 'supabase');
    if (b === 'gas') sessionStorage.removeItem('upc_backend');
    if (sessionStorage.getItem('upc_backend') === 'supabase') {
      cfg.API_KIND = 'supabase';
      cfg.API_URL = cfg.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/api';
    }
  } catch (e) {}

  // Local development: open any page with ?mock=1 to run against an in-browser fake sheet
  // (no real data, nothing leaves your machine). ?mock=0 switches it back off. Takes precedence over ?backend.
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q === '1') sessionStorage.setItem('upc_mock', '1');
    if (q === '0') sessionStorage.removeItem('upc_mock');
    if (sessionStorage.getItem('upc_mock') === '1') { cfg.API_URL = 'mock'; cfg.API_KIND = 'gas'; }
  } catch (e) {}

  window.APP_CONFIG = cfg;
})();

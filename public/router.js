(() => {
  "use strict";
  const { readBootstrap, views } = window.AirShare;
  const titles = {
    home: "AirShare",
    recipes: "AirShare Recipes",
    about: "AirShare About",
    privacy: "AirShare Privacy",
    license: "AirShare License",
    receiver: "AirShare Download",
    send: "AirShare Upload",
    notfound: "AirShare Page Not Found",
  };
  const bootstrap = readBootstrap();
  let active = null;

  function match(pathname) {
    if (pathname === "/" || pathname === "/index.html") return { view: "home" };
    const info = pathname.match(/^\/(recipes|about|privacy|license)$/);
    if (info) return { view: info[1] };
    const page = pathname.match(/^\/(r|recv|s|send)\/([^/]+)$/);
    if (!page) return null;
    try {
      return { view: page[1] === "r" || page[1] === "recv" ? "receiver" : "send", key: decodeURIComponent(page[2]) };
    } catch {
      return null;
    }
  }

  function show(route) {
    const next = route || { view: "notfound" };
    if (active && (active.view !== next.view || active.key !== next.key)) views[active.view]?.unmount?.();
    const changed = !active || active.view !== next.view || active.key !== next.key;
    for (const section of document.querySelectorAll("[data-view]")) section.hidden = section.dataset.view !== next.view;
    document.title = titles[next.view];
    for (const link of document.querySelectorAll("[data-nav]")) {
      const current = link.dataset.nav === next.view;
      link.classList.toggle("active", current);
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    active = next;
    if (changed) void views[next.view]?.mount?.({ key: next.key, bootstrap });
  }

  function focusContent() {
    document.querySelector("#content")?.focus({ preventScroll: true });
  }

  function navigate(url, route) {
    const target = url.pathname + url.search + url.hash;
    if (target !== location.pathname + location.search + location.hash) {
      history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, "");
      history.pushState({ scrollY: 0 }, "", target);
    }
    show(route);
    let anchor = null;
    try {
      anchor = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
    } catch {}
    if (anchor) anchor.scrollIntoView();
    else window.scrollTo(0, 0);
    focusContent();
  }

  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target?.closest?.("a[href]");
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    const route = match(url.pathname);
    if (!route) return;
    // Same-document fragment links keep their native scrolling behaviour.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    navigate(url, route);
  });

  window.addEventListener("popstate", (event) => {
    show(match(location.pathname));
    if (typeof event.state?.scrollY === "number") window.scrollTo(0, event.state.scrollY);
  });

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const initial = document.querySelector("[data-view]:not([hidden])")?.dataset.view;
  show(initial === "notfound" ? null : match(location.pathname));
  window.AirShare.router = {
    match,
    current: () => active?.view ?? null,
    navigate: (href) => {
      const url = new URL(href, location.href);
      navigate(url, match(url.pathname));
    },
  };
})();

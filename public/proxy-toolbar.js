(() => {
  const params = new URLSearchParams(window.location.search);
  const initialDestination = params.get("url");
  if (!initialDestination || !document.documentElement) return;

  const host = document.createElement("div");
  host.id = "myweb-proxy-toolbar-host";
  host.setAttribute("aria-label", "MyWeb Proxy navigation");
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;height:58px;";

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{all:initial;display:block;color:#edf3f0;font-family:Manrope,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      *{box-sizing:border-box}
      .bar{height:58px;display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(11,17,22,.97);border-bottom:1px solid #314047;box-shadow:0 5px 22px rgba(0,0,0,.25);backdrop-filter:blur(14px)}
      .brand{display:flex;align-items:center;gap:7px;min-width:118px;color:#eff5f2;font-size:12px;font-weight:800;letter-spacing:-.04em;text-decoration:none}
      .mark{width:20px;height:20px;border:1px solid #a9e36d;border-radius:6px;position:relative;display:inline-block}
      .mark:after{content:"";position:absolute;width:7px;height:7px;left:5px;top:5px;border:1.5px solid #a9e36d;border-radius:50%}
      .controls{display:flex;gap:4px}
      button{width:34px;height:34px;border:1px solid #35444a;border-radius:8px;background:#152027;color:#dce6e1;font:16px system-ui,sans-serif;cursor:pointer}
      button:hover{border-color:#a9e36d;color:#a9e36d}
      form{display:flex;align-items:center;flex:1;min-width:0;height:36px;margin-left:4px;border:1px solid #35444a;border-radius:9px;background:#10181d;overflow:hidden}
      input{width:100%;min-width:0;padding:0 12px;border:0;outline:0;background:transparent;color:#dce6e1;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
      .go{width:auto;flex:0 0 auto;padding:0 12px;border:0;border-left:1px solid #35444a;border-radius:0;background:#a9e36d;color:#152014;font-size:11px;font-weight:800}
      .go:hover{color:#152014;background:#baf08a}
      @media(max-width:620px){.bar{gap:5px;padding:7px 8px}.brand{min-width:0;font-size:0}.brand .mark{flex:0 0 20px}.controls{gap:3px}button{width:30px;height:32px}form{margin-left:0}input{font-size:11px;padding:0 8px}.go{padding:0 9px}}
    </style>
    <nav class="bar" aria-label="Proxy navigation">
      <a class="brand" href="/" title="MyWeb Proxy home"><span class="mark" aria-hidden="true"></span><span>myweb / proxy</span></a>
      <div class="controls">
        <button type="button" data-action="back" aria-label="Go back" title="Back">‹</button>
        <button type="button" data-action="forward" aria-label="Go forward" title="Forward">›</button>
        <button type="button" data-action="reload" aria-label="Reload page" title="Reload">↻</button>
      </div>
      <form id="proxy-toolbar-form" role="search">
        <input id="proxy-toolbar-address" type="text" inputmode="url" autocomplete="url" spellcheck="false" aria-label="Current destination" />
        <button class="go" type="submit">Go</button>
      </form>
      <button type="button" data-action="home" aria-label="Go to proxy home" title="Home">⌂</button>
    </nav>`;

  const address = shadow.querySelector("#proxy-toolbar-address");
  address.value = initialDestination;

  shadow.querySelector("[data-action='back']").addEventListener("click", () => window.history.back());
  shadow.querySelector("[data-action='forward']").addEventListener("click", () => window.history.forward());
  shadow.querySelector("[data-action='reload']").addEventListener("click", () => window.location.reload());
  shadow.querySelector("[data-action='home']").addEventListener("click", () => window.location.assign("/"));
  shadow.querySelector(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    window.location.assign("/");
  });
  shadow.querySelector("#proxy-toolbar-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let raw = address.value.trim();
    if (!raw) return;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const target = new URL(raw);
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("protocol");
      if (target.username || target.password) throw new Error("credentials");
      window.location.assign(`/proxy?url=${encodeURIComponent(target.href)}`);
    } catch {
      address.setCustomValidity("Enter a valid HTTP or HTTPS address.");
      address.reportValidity();
      address.addEventListener("input", () => address.setCustomValidity(""), { once: true });
    }
  });

  document.documentElement.append(host);
})();

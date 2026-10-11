## 2023-10-27 - Replace innerHTML with DOM methods to prevent XSS
**Vulnerability:** Use of `innerHTML` in `js/app.js` to render proxy URL error messages, even though `escapeHtml` was used, presents a risk if not careful and goes against the codebase philosophy of avoiding `innerHTML`.
**Learning:** The codebase explicitly documents in `js/ui.js` that `innerHTML` should never be used, as it creates a pathway for XSS if AI-generated text, external data, or user input is rendered. The project provides an `el(tag, attrs, ...children)` helper to create nodes safely.
**Prevention:** Always use `textContent`, `replaceChildren`, or the custom `el` utility when constructing UI elements dynamically in this project.

## 2026-09-07 - Add security headers to proxy servers
**Vulnerability:** Missing strict security headers in API proxies (worker.js and node-proxy.mjs).
**Learning:** API proxy servers should explicitly prevent execution, embedding, and enforce secure transport, even if CORS is properly configured. Relying solely on CORS does not prevent tools or attackers directly calling the proxy server or browsers from caching the contents inappropriately.
**Prevention:** Apply `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, and `Strict-Transport-Security: max-age=31536000` explicitly to API endpoints.

## 2026-09-11 - Add javascript: URI validation to prevent XSS
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` protected against `innerHTML` XSS, but lacked validation for `href` attributes, making it possible for AI-generated or external URLs to inject `javascript:` URIs and execute malicious code upon clicking.
**Learning:** Preventing `innerHTML` usage is not the only vector for XSS; attributes, specifically `href` and `src`, can also carry execution contexts.
**Prevention:** Added robust `v.trim().toLowerCase().startsWith("javascript:")` checking in the `el()` function to neutralize any `href` attribute containing a `javascript:` URI by replacing it with `about:blank`.

## 2026-09-12 - Prevent javascript: URI XSS in admin UI
**Vulnerability:** Similar to js/ui.js, the el() helper in admin/admin.js lacked validation for href attributes, leaving a risk for javascript: URI injection.
**Learning:** When addressing a vulnerability like XSS in a specific utility function, check if the project has duplicated or similar utility functions (e.g. for different scopes like admin vs main UI) that might suffer from the same vulnerability.
**Prevention:** Added javascript: URI check and neutralized it with about:blank in admin/admin.js el() function, same as js/ui.js.

## 2026-09-12 - Prevent URI XSS via control characters in attributes
**Vulnerability:** The javascript: URI check in href attributes could be bypassed using control characters (e.g. \x09 or \x00), and other attributes like src and action were not checked, leading to potential XSS execution. Additionally, vbscript: was not restricted.
**Learning:** Checking for javascript: URIs must account for how browsers parse URLs, specifically by ignoring control characters (ASCII 0-32). Checking only href is insufficient as src and action can also execute code.
**Prevention:** Sanitize href, src, and action attributes by stripping all [\x00-\x20] control characters before matching against javascript: and vbscript:.

## 2026-09-17 - Prevent XSS via data: URIs in attributes
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` and `admin/admin.js` protected against `javascript:` and `vbscript:` URI XSS, but lacked validation for dangerous `data:` URIs (e.g. `data:text/html`). Attackers could exploit this to inject malicious code using `href`, `src`, or `action` attributes.
**Learning:** `data:` URIs can act as a vector for XSS in addition to `javascript:` and `vbscript:`. Allowing arbitrary `data:` URIs, especially those containing text or HTML, presents a security risk. However, completely blocking `data:` URIs breaks legitimate use cases like inline `data:image/` URIs.
**Prevention:** Added check for dangerous `data:` URIs in the `el()` function (excluding `data:image/`) to neutralize them in `href`, `src`, or `action` attributes by replacing them with `about:blank`.

## 2026-09-19 - Prevent javascript: URI XSS in formaction attributes
**Vulnerability:** The javascript: URI check in the custom `el()` DOM helper in `js/ui.js` and `admin/admin.js` protected against `javascript:`, `vbscript:`, and dangerous `data:` URIs in `href`, `src`, and `action` attributes. However, it omitted the `formaction` attribute, which could still be exploited to inject malicious code (XSS) via form submission buttons.
**Learning:** The `formaction` attribute behaves identically to the `action` attribute for form-related elements like `<button>` and `<input>`, and must also be sanitized to fully prevent execution contexts in HTML attributes.
**Prevention:** Added `formaction` to the list of sanitized attributes in both `el()` functions to neutralize any malicious URIs by replacing them with `about:blank`.

## 2026-09-22 - Prevent XSS via inline event handlers passed as strings
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` and `admin/admin.js` allowed `on*` inline event handlers to be passed as strings (e.g. `onclick="malicious_code()"`), which would be set as attributes via `setAttribute(k, v)`, potentially leading to XSS if an attacker could control both the attribute name and value.
**Learning:** Checking for safe attributes should also cover the risk of dynamic attribute assignment allowing inline event handlers (`on*`). Event listeners should only be attached using `addEventListener` with safe function references, not string payloads.
**Prevention:** Explicitly neutralize any `on*` attribute passed as a string by doing nothing and thus preventing it from being added to the element in both `el()` DOM helper functions.

## 2026-09-23 - Prevent case-insensitive attribute bypasses for XSS
**Vulnerability:** The central `el()` DOM helpers in `js/ui.js` and `admin/admin.js` checked attributes for security risks (`href`, `src`, `action`, `formaction`, and `on*`) using exact string comparisons (case-sensitive) on the attribute names. Because HTML attribute names are case-insensitive in the DOM, an attacker could bypass these checks by providing attributes with uppercase characters, such as `HREF` or `ONCLICK`.
**Learning:** Security checks that validate or filter keys intended to become HTML attributes must account for HTML's case-insensitivity. Checking `k === "href"` is insufficient; it must be `k.toLowerCase() === "href"`.
**Prevention:** Normalize attribute keys to lowercase before performing any blocklist or sanitization checks in functions that map object keys to DOM attributes.
## 2026-10-08 - Prevent XSS via array/object type coercion in URL attributes and inline event handlers
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` and `admin/admin.js` checked for potentially dangerous attributes such as inline event handlers (`on*`) and URL attributes (`href`, `src`, `action`, `formaction`) by validating that `typeof v === "string"`. This check could be bypassed by passing an array or object containing the malicious payload (e.g. `{ href: ["javascript:alert(1)"] }`). The bypassed value would then be implicitly coerced to a string when assigned using `node.setAttribute(k, v)`, leading to XSS execution.
**Learning:** Type checking like `typeof v === "string"` before sanitization is insufficient if the downstream sinking method (`setAttribute`) automatically coerces values to strings. Bypassing the check with array or object wrappers is a common technique to defeat strict type validations in custom DOM helpers.
**Prevention:** Removed the `typeof v === "string"` condition. For dangerous URL attributes, explicitly cast the input to a string (`String(v)`) *before* applying sanitization. For inline event handlers, neutralize all inputs that are not explicitly functions.

## 2026-10-10 - Prevent XSS via object data attribute
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` and `admin/admin.js` protected against XSS in `href`, `src`, `action`, and `formaction` attributes, but missed the `data` attribute. This allowed attackers to use `<object data="javascript:alert(1)">` to execute malicious code.
**Learning:** Preventing XSS via element attributes requires identifying *all* attributes that can act as an execution sink. The `data` attribute of the `<object>` tag can evaluate URIs similarly to `href` or `src`.
**Prevention:** Added `data` to the list of sanitized attributes in both `el()` functions to neutralize any malicious URIs (e.g. `javascript:`, `vbscript:`, dangerous `data:` URIs) by replacing them with `about:blank`.

## 2026-10-11 - Prevent XSS via HTML injection in srcdoc attribute
**Vulnerability:** The central `el()` DOM helper in `js/ui.js` and `admin/admin.js` prevented injection in attributes like `href`, `src`, `data`, and inline event handlers, but missed the `srcdoc` attribute. If an attacker controlled the attribute name or values, they could inject arbitrary HTML containing `<script>` tags by setting `srcdoc="<script>alert(1)</script>"` on an `<iframe>`.
**Learning:** The `srcdoc` attribute accepts raw HTML rather than a URI, so validating URI schemes (like checking for `javascript:`) is fundamentally incorrect for preventing XSS in `srcdoc`. Since the overarching design philosophy of this codebase strictly avoids parsing string payloads as HTML (no `innerHTML`), allowing `srcdoc` breaks this guarantee.
**Prevention:** Added an explicit drop condition `} else if (lowerK === "srcdoc") { /* do nothing */ }` to neutralize the `srcdoc` attribute entirely inside the `el()` DOM helper, ensuring no HTML injection vectors remain.
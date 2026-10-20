#!/usr/bin/env python3
"""
Linux GTK3 + WebKit2GTK native host for Job Tracker (jp.jobtracker.app).
Manages the local Node.js backend subprocess, enforces strict WebView origin
isolation, and terminates the backend cleanly on exit.
"""
import json
import os
import signal
import subprocess
import sys
import urllib.parse
import webbrowser


def parse_normalized_origin(url_str):
    if not isinstance(url_str, str) or not url_str:
        return None
    if any(ord(ch) <= 0x20 or ord(ch) == 0x7F or ch == '"' for ch in url_str):
        return None
    try:
        parsed = urllib.parse.urlsplit(url_str)
    except Exception:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    scheme = (parsed.scheme or "").lower()
    hostname = (parsed.hostname or "").lower()
    if scheme not in ("http", "https") or not hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port is None:
        port = 443 if scheme == "https" else 80
    if not (1 <= port <= 65535):
        return None
    return (scheme, hostname, port)


def is_allowed_navigation_url(candidate_url, allowed_origin_url):
    allowed = parse_normalized_origin(allowed_origin_url)
    candidate = parse_normalized_origin(candidate_url)
    if allowed is None or candidate is None:
        return False
    return candidate == allowed


def is_safe_external_https_url(candidate_url):
    if not isinstance(candidate_url, str):
        return False
    trimmed = candidate_url.strip()
    if not trimmed or trimmed.startswith("-"):
        return False
    if any(ord(ch) <= 0x20 or ord(ch) == 0x7F or ch == '"' for ch in trimmed):
        return False
    try:
        parsed = urllib.parse.urlsplit(trimmed)
        port = parsed.port
    except Exception:
        return False
    if (parsed.scheme or "").lower() != "https":
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    if not parsed.hostname:
        return False
    if port is not None and not (1 <= port <= 65535):
        return False
    return True


def run_origin_policy_self_test():
    allowed_origin = "http://127.0.0.1:4321"
    must_allow = [
        "http://127.0.0.1:4321/",
        "http://127.0.0.1:4321/api/companies?x=1",
    ]
    for u in must_allow:
        if not is_allowed_navigation_url(u, allowed_origin):
            sys.stderr.write(f"Expected allow failed: {u}\n")
            return 1

    must_reject_nav = [
        "http://127.0.0.1:43210/",
        "http://127.0.0.1:80/",
        "http://127.0.0.1/",
        "http://127.0.0.1:4321@evil.example.com/",
        "http://user:pass@127.0.0.1:4321/",
        "https://127.0.0.1:4321/",
        "https://example.com/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "about:blank",
    ]
    for u in must_reject_nav:
        if is_allowed_navigation_url(u, allowed_origin):
            sys.stderr.write(f"Expected reject passed: {u}\n")
            return 1

    if not is_safe_external_https_url("https://example.com/jobs?id=1"):
        sys.stderr.write("Expected valid external https to pass\n")
        return 1

    must_reject_ext = [
        "http://example.com/",
        "https://user:pass@example.com/",
        "https://127.0.0.1:4321@example.com/",
        "-https://example.com/",
        "https://example.com/bad path",
        "file:///etc/passwd",
        "javascript:alert(1)",
    ]
    for u in must_reject_ext:
        if is_safe_external_https_url(u):
            sys.stderr.write(f"Expected external reject passed: {u}\n")
            return 1

    print("ORIGIN_POLICY_SELF_TEST_OK")
    return 0


def main():
    if "--test-origin-policy" in sys.argv:
        sys.exit(run_origin_policy_self_test())

    app_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    cli_path = os.path.join(app_root, "src", "backend", "cli.cjs")

    proc = subprocess.Popen(
        ["node", cli_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )

    def cleanup(*_args):
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except Exception:
                proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()

    signal.signal(signal.SIGINT, lambda *a: (cleanup(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *a: (cleanup(), sys.exit(0)))

    line = proc.stdout.readline().strip()
    if not line:
        cleanup()
        sys.exit(1)

    info = json.loads(line)
    base_url = info["url"]
    allowed_origin = info.get("origin") or base_url

    if "--smoke-test" in sys.argv:
        print(f"SMOKE_TEST_OK:{base_url}")
        cleanup()
        sys.exit(0)

    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gio, Gtk, WebKit2

        win = Gtk.Window(title="就活トラッカー")
        win.set_default_size(1280, 820)
        win.set_size_request(360, 420)
        win.connect("destroy", lambda *_: (cleanup(), Gtk.main_quit()))

        webview = WebKit2.WebView()

        def on_decide_policy(_wv, decision, decision_type):
            if decision_type in (
                WebKit2.PolicyDecisionType.NAVIGATION_ACTION,
                WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION,
            ):
                nav_action = decision.get_navigation_action()
                request = nav_action.get_request() if nav_action else None
                uri = request.get_uri() if request else ""
                if (
                    decision_type == WebKit2.PolicyDecisionType.NAVIGATION_ACTION
                    and is_allowed_navigation_url(uri, allowed_origin)
                ):
                    decision.use()
                    return True
                decision.ignore()
                if is_safe_external_https_url(uri):
                    try:
                        Gio.AppInfo.launch_default_for_uri(uri.strip(), None)
                    except Exception:
                        pass
                return True
            return False

        webview.connect("decide-policy", on_decide_policy)
        webview.load_uri(base_url)
        win.add(webview)
        win.show_all()
        Gtk.main()
    except Exception:
        if is_allowed_navigation_url(base_url, allowed_origin):
            webbrowser.open(base_url)
            proc.wait()
    finally:
        cleanup()


if __name__ == "__main__":
    main()

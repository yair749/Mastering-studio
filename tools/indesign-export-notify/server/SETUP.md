# Self-hosting ntfy on the export PC (Windows)

End result: staff open **https://export-pc** in Chrome or Edge, log in once, and get a desktop pop-up when an export finishes, even with the tab closed. Everything stays on your office network. Nothing is sent to a public server.

```
 InDesign ──(export-notify.jsx)──► ntfy on export PC ──► staff browsers (https://export-pc)
           http://127.0.0.1:2586     (Windows service)     login required, notifications
           this PC only                                    arrive with the tab closed
```

| Tool | Stars | Cost | Role |
|---|---|---|---|
| [ntfy](https://github.com/binwiederhier/ntfy) v2.28.0 | 34k | Free, open source | Server + web app. Runs natively on Windows as a service, no Docker needed |
| [mkcert](https://github.com/FiloSottile/mkcert) v1.4.4 | 59k | Free, open source | Makes the HTTPS certificate browsers need for notifications |

Plan about 30–45 minutes. Run all commands in **PowerShell as Administrator** on the export PC unless it says otherwise.

---

## 0. Sandbox check first (our policy)

Download both tools and put them through the sandbox security checks before they touch the export PC:

- ntfy: `ntfy_2.28.0_windows_amd64.zip` and `checksums.txt` from
  https://github.com/binwiederhier/ntfy/releases/tag/v2.28.0
  Verify the download matches the published checksum:
  ```powershell
  (Get-FileHash .\ntfy_2.28.0_windows_amd64.zip -Algorithm SHA256).Hash.ToLower()
  Select-String "windows_amd64.zip" .\checksums.txt
  ```
  The two values must be identical.
- mkcert: `winget install FiloSottile.mkcert` (winget checks the file hash), or `mkcert-v1.4.4-windows-amd64.exe` from
  https://github.com/FiloSottile/mkcert/releases/tag/v1.4.4. mkcert doesn't publish checksums, so the sandbox scan matters more here.

## 1. Give the export PC a fixed name and address

Staff reach the server by the PC's name, so it must not change.

```powershell
hostname                       # e.g. EXPORT-PC; this is the name staff will type
Get-NetIPAddress -AddressFamily IPv4 | Where-Object PrefixOrigin -ne WellKnown | Select IPAddress
```

Ask whoever runs your router or network to **reserve that IP address** for the export PC. This guide uses `EXPORT-PC` and `192.168.1.50`; replace them with your values everywhere below.

## 2. Install ntfy

```powershell
New-Item -ItemType Directory -Force C:\ntfy, C:\ProgramData\ntfy\certs | Out-Null
Expand-Archive .\ntfy_2.28.0_windows_amd64.zip -DestinationPath $env:TEMP\ntfy -Force
Copy-Item "$env:TEMP\ntfy\ntfy_2.28.0_windows_amd64\ntfy.exe" C:\ntfy\
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\ntfy", "Machine")
$env:Path += ";C:\ntfy"
ntfy --help                    # should print the ntfy help text
```

## 3. Make the HTTPS certificate

```powershell
mkcert -install                # creates your private certificate authority and trusts it on this PC
mkcert -cert-file C:\ProgramData\ntfy\certs\ntfy.pem -key-file C:\ProgramData\ntfy\certs\ntfy-key.pem `
       export-pc export-pc.local localhost 127.0.0.1 192.168.1.50
mkcert -CAROOT                 # shows the folder holding rootCA.pem and rootCA-key.pem
```

> **Security:** `rootCA-key.pem` can create certificates that every staff PC trusts, for *any* website. After this step, copy it to an encrypted USB stick or password manager, then **delete it from the PC**. You only need it again when the certificate is renewed. Only `rootCA.pem` (no `-key`) goes to staff PCs.

The certificate lasts about 2 years and 3 months; mkcert printed the expiry date. Put a renewal reminder in the calendar.

## 4. Configure ntfy

1. Copy `server.yml` from this folder to `C:\ProgramData\ntfy\server.yml`. ntfy looks there by default.
2. Generate the browser-notification keys and paste the two values into `server.yml`:
   ```powershell
   ntfy webpush keys
   ```
3. Replace the rest of the `CHANGE-ME` values: `base-url: "https://export-pc"` and a real admin email address.
4. Check no placeholders are left:
   ```powershell
   Select-String CHANGE-ME C:\ProgramData\ntfy\server.yml      # should print nothing
   ```

Do **not** change the web-push keys later. Every browser would have to re-subscribe.

## 5. Create the logins

Each command asks for a password.

```powershell
ntfy user add --role=admin admin          # you: full access
ntfy user add studio                      # shared staff login: can only READ exports
ntfy access studio exports read-only
ntfy user add export-pc                   # used only by the InDesign script (any long password)
ntfy access export-pc exports write-only
ntfy token add --label "InDesign script" export-pc
```

Save the `tk_...` token from the last command for step 8. Treat it like a password.

Want per-person logins instead of a shared one? Repeat the `studio` pair of lines for each person (`ntfy user add dana`, `ntfy access dana exports read-only`). To remove someone: `ntfy user del dana`.

## 6. Test run, then install as a service

Run ntfy in the foreground once, so any errors show on screen:

```powershell
ntfy serve
```

Look for `Listening on 127.0.0.1:2586[http] :443[https]`. Open https://export-pc on the export PC; you should get the ntfy login page with a padlock. Press `Ctrl+C` to stop it. Then install it as a service that starts with Windows:

```powershell
sc.exe create ntfy binPath= "C:\ntfy\ntfy.exe serve" start= auto DisplayName= "ntfy notifications"
sc.exe failure ntfy reset= 86400 actions= restart/5000/restart/5000/restart/60000
sc.exe start ntfy
New-NetFirewallRule -DisplayName "ntfy HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 `
                    -Action Allow -Profile Domain,Private
```

Use `sc.exe`, not `sc`: in PowerShell, `sc` means something else. The service name must be `ntfy`. The space after each `=` is required.

If port 443 is already taken on this PC (for example by IIS), use `listen-https: ":8443"` and `base-url: "https://export-pc:8443"` instead, and open 8443 in the firewall rule.

## 7. Test from the export PC

```powershell
curl.exe -H "Authorization: Bearer tk_YOUR_TOKEN" -H "Title: test" -d "hello" http://127.0.0.1:2586/exports
```

This should return a line of JSON. A `403` means the token or access rule is wrong.

## 8. Point the InDesign script at it

In `export-notify.jsx`:

```js
server: "http://127.0.0.1:2586",
topic: "exports",
token: "tk_YOUR_TOKEN",
```

Then install the script as described in the main README.

## 9. Each staff computer (about 2 minutes each)

1. **Trust the certificate.** Copy `rootCA.pem` to the PC (for example via a shared folder) and run it once, as the staff member, in normal PowerShell:
   ```powershell
   certutil -user -addstore Root .\rootCA.pem       # click "Yes" on the warning
   ```
   On a Mac: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem`.
   If you have a Windows domain, IT can push `rootCA.pem` to every PC with Group Policy instead.
2. Open **https://export-pc** in Chrome or Edge and log in as `studio`.
3. Click **Subscribe to topic**, type `exports`, and subscribe.
4. Allow notifications when the browser asks.
5. **Settings → Background notifications → enable.** Without this, pop-ups only arrive while the tab is open.
6. Optional: in Edge, **⋯ → Apps → Install this site as an app**; in Chrome, the install icon in the address bar. ntfy then works like a normal program in the taskbar.

## Maintenance

- **Backup:** `C:\ProgramData\ntfy` (logins, message history, browser subscriptions, certificates).
- **Update ntfy:** check the releases page occasionally. To update: sandbox the new zip, `sc.exe stop ntfy`, replace `C:\ntfy\ntfy.exe`, `sc.exe start ntfy`.
- **Internet access:** background notifications are delivered through the browser's own push service (Google for Chrome, Microsoft for Edge), so the export PC needs normal outbound internet access. That traffic is end-to-end encrypted under the Web Push standard; the push service can't read it.
- **Staff who don't open ntfy for ~2 months** get a "Notifications will be paused" pop-up; opening https://export-pc once renews it.
- **Logs:** if the service misbehaves, stop it and run `ntfy serve` in a window to see errors.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows "Not secure" / certificate warning | Step 9.1 wasn't done on that PC, or the address isn't one of the names in step 3 |
| "Notifications are blocked" banner in ntfy | Click the padlock → Site settings → Notifications → Allow |
| No pop-up when the tab is closed | Step 9.5 (Background notifications), and the browser must still be running |
| `https://export-pc` doesn't load from other PCs | Firewall rule (step 6), or the network doesn't resolve the name; try `https://192.168.1.50` |
| Script sends nothing, `curl` test returns 403 | Wrong token, or step 5 `ntfy access export-pc exports write-only` missing |

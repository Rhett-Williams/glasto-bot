# glasto-bot

Get an army of bots to help you get into Glasto.

Opens several browser windows at once, each one a separate [Multilogin X](https://multilogin.com) profile with its own browser fingerprint and its own [Bright Data](https://brightdata.com) proxy IP. Every window loads the same page, and the script keeps an eye on all of them. When the text you're waiting for appears in any tab, it beeps and pops that window to the front so you can take over.

The script never clicks or reloads anything for you — it just reads the page in each tab and tells you which one got through.

## Requirements

- **Node.js 20.6+** (uses `--env-file`)
- **Multilogin X** account, with the desktop app/agent installed and running
- **Bright Data** account with a zone that has one IP per profile you plan to run

## Setup

### 1. Install dependencies

```sh
npm install playwright undici
```

You don't need to download Playwright's browsers — the script attaches to the browsers Multilogin launches.

### 2. Set up a Bright Data proxy on each Multilogin profile

Proxies are configured on the profiles in the Multilogin app, not in this repo. For each profile, set:

| Field    | Value                                                          |
| -------- | -------------------------------------------------------------- |
| Type     | HTTP                                                           |
| Host     | `brd.superproxy.io`                                            |
| Port     | `44445`                                                        |
| Username | `brd-customer-<customer_id>-zone-<zone>-ip-<one of your IPs>` |
| Password | your zone password                                             |

Give each profile a **different** IP. The script warns on startup if two profiles come out on the same IP.

### 3. Create your `.env`

```sh
cp env.example .env
```

Then fill it in:

| Variable          | Required | Description                                                                                 |
| ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `MLX_TOKEN`       | one of   | Multilogin automation token (recommended)                                                   |
| `MLX_EMAIL`       | one of   | Multilogin account email — use with `MLX_PASSWORD` instead of a token                       |
| `MLX_PASSWORD`    | one of   | Multilogin account password                                                                 |
| `MLX_FOLDER_ID`   | yes      | ID of the Multilogin folder your profiles live in                                           |
| `MLX_PROFILE_IDS` | yes      | Comma-separated profile IDs — one window opens per profile                                  |
| `START_URL`       | no       | Page every window opens on start (default `https://browserleaks.com/ip`)                    |
| `MATCH_STRING`    | no       | Text to wait for (default `Hello world`)                                                    |
| `MATCH_IN`        | no       | `html` to search the full page source, `text` to search only visible text (default `html`) |
| `POLL_MS`         | no       | How often each tab is checked, in ms (default `1000`)                                       |
| `MLX_LAUNCHER`    | no       | Multilogin launcher URL (default `https://launcher.mlx.yt:45001`)                           |

`.env` is gitignored — **never commit it**.

## Usage

Make sure the Multilogin app is running, then:

```sh
node --env-file=.env brightdata-browser.js
```

To open a different page without editing `.env`, pass the URL as an argument:

```sh
node --env-file=.env brightdata-browser.js https://example.com/tickets
```

On startup each window logs the public IP it's using:

```
[1] profile 1a2b...  IP 203.0.113.10
[2] profile 3c4d...  IP 203.0.113.11
2 profile(s) open, watching for "Hello world" every 1000ms.
Close all windows or press Ctrl+C to exit.
```

When a tab matches, you'll hear a terminal bell and see:

```
[2] FOUND "Hello world" on https://...
```

That window is raised to the front. Each tab alerts once per appearance of the text, and again if it disappears and comes back.

Closing every window or pressing **Ctrl+C** stops all the Multilogin profiles and exits.

### Tips

- Run it first against the default `START_URL` (an IP checker) to confirm every profile has a different IP before the real thing.
- Pick a `MATCH_STRING` that only appears on the page you're waiting for, not on the waiting/queue page.
- With `MATCH_IN=html`, the string can match hidden markup too. Switch to `text` if you're getting false alerts.

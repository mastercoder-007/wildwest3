# Wild West Duel (public version)

Your phones are the guns. **Two phones are enough**: the bell rings on both phones, whoever shoots
first wins. The laptop screen (`/arena`) is optional, a big scoreboard for the room. Anyone can open the
website, and **people on the same Wi-Fi are automatically put in the same duel room**. No accounts.
It also includes an **admin page** (`/admin`) with visitor and match data.

```
public/phone.html   the phone screen (served at "/")
public/arena.html   the laptop screen (served at "/arena")
public/admin.html   your control room (served at "/admin", needs a password)
public/config.js    only needed if the pages live on Vercel (see Option B)
server.js           the web server + WebSockets (needs only Node.js)
lib/room.js         the duel referee (rules, rounds, fouls, winner)
lib/net.js          works out "which Wi-Fi is this?"
lib/stats.js        visitor and match statistics
lib/admin.js        admin login, settings, exports
lib/websocket.js    tiny WebSocket implementation
```

## How "same Wi-Fi" works (and where it can fail)

All devices on one Wi-Fi reach the internet through the same public address, so the server groups
visitors by that address. We store only a scrambled version of it, never the address itself.

It can fail when:
- a phone is on **mobile data** or a **VPN** (different address from the laptop's Wi-Fi). Turn those off.
- a phone and the laptop use **different internet versions** (IPv4 vs IPv6). That is what the small
  "Can't find your opponent? Enter their room code" link is for: each phone's waiting screen (and the
  laptop screen, if used) shows a 4-letter code. To switch that fallback off, set `ALLOW_ROOM_CODES=0`.
- some **school/office networks** put every device behind a different address.

## Option A (easiest): everything on Render, from your GitHub

1. Make a GitHub repository and upload this folder. **Do not upload the `cert` or `data` folders**
   (the included `.gitignore` already skips them if you use git):
   ```
   git init
   git add .
   git commit -m "wild west duel"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
   git push -u origin main
   ```
2. Go to render.com, sign in with GitHub, then **New > Blueprint**, pick your repository.
   Render reads `render.yaml`, asks you to type an `ADMIN_PASSWORD` (choose a long one), then deploys.
   (Without the Blueprint: New > Web Service, Runtime **Node**, Build Command `echo ok`,
   Start Command `node server.js`, and add the `ADMIN_PASSWORD` environment variable.)
3. When it is live you get an address like `https://wildwest-duel.onrender.com`.
   - Laptop: open `/arena`
   - Phones: open the main address
   - You: open `/admin` and log in.
4. **Check the network setting once:** in `/admin`, look at **Network check**. The address shown
   (last number hidden) should match your real public address (search "what is my ip").
   If it shows a private/host address, set the environment variable `IP_HEADER` on Render to the
   header listed under "Headers seen" (for example `x-forwarded-for`), and redeploy.

Free-plan notes (check Render's current free-plan limits, they change):
- Free services can go to sleep when nobody visits; the first visit then takes a while to wake it.
- The free disk is **wiped on restart/redeploy**, so your statistics would reset. Use the
  **Download** buttons in `/admin` regularly, or use a paid plan with a persistent disk and set
  `DATA_DIR` to that disk's path.

## Option B: pages on Vercel, game server on Render

Vercel can host the pages from your GitHub, but **it cannot run the game server** (it only runs
short functions, the game needs a connection that stays open). So the server still goes on Render.

1. Do Option A first (so the server exists), and note its address, e.g. `https://wildwest-duel.onrender.com`.
2. Open `public/config.js` and set:
   ```js
   window.DUEL_SERVER = 'https://wildwest-duel.onrender.com';
   ```
   Commit and push.
3. On Render, add the environment variable `ALLOWED_ORIGINS` = your Vercel address
   (for example `https://wildwest-duel.vercel.app`, no slash at the end; separate several with commas).
4. On vercel.com: **Add New > Project**, import the same repository. The included `vercel.json`
   already tells Vercel to publish the `public` folder with no build step. Deploy.
5. Phones and laptop open the **Vercel** address (`/` and `/arena`). Your admin page stays on the
   **Render** address (`/admin`), because that is where the data lives.

## Option C: at home, no internet needed

Install Node.js, double-click `start.bat`, open `https://localhost:8443/arena` on the laptop and the
`https://192.168...` address shown on the phones (click through the certificate warning).
At home everyone is automatically in one room. The admin page is `https://localhost:8443/admin`;
the temporary password is printed in the black window (set `ADMIN_PASSWORD` to choose your own).

## Settings (environment variables)

| Name | What it does |
|---|---|
| `ADMIN_PASSWORD` | Password for `/admin`. **Set this online.** If missing, a temporary one is printed in the log. |
| `PORT` | Set by hosts automatically. Its presence switches on "online mode" (plain http, the host adds https). |
| `ALLOWED_ORIGINS` | Option B only: the Vercel address(es) allowed to use the server. |
| `IP_HEADER` | Which header holds the visitor's real address (default: tried automatically). |
| `TRUST_PROXY_HOPS` | Only with `x-forwarded-for`: how many proxies sit in front of the server (default 1). |
| `ALLOW_ROOM_CODES` | `0` switches off the room-code fallback. |
| `DATA_DIR` | Where statistics are saved (default `./data`). |

You can also change rounds-to-win, wait times, pause the game, and show a message to players from `/admin`.

## What the dashboard records

Page visits (once per visitor per day), players who joined, matches started/finished/left early,
how long matches take, fastest reaction times, device type, country (only if your host sends it),
and which hours people play. **No IP addresses are stored**, but names players type and match
results are. If you run this publicly, tell visitors (the phone page has a short note) and check the
privacy rules where you live.

## The background picture

`public/bg.webp` is a screenshot from a commercial game. That is fine for a small private project,
but replace it with your own picture or a free-licence one if the site grows.

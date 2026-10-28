# Smart CRM — Cloudflare version (RK Garg Jeans)

App ab Cloudflare pe chalta hai: **tez screens, turant save**. Data Cloudflare ke database (D1) mein,
aur Google Sheet har 5 minute mein update hoti hai (report + backup). Sheet mein kiya badlav bhi app mein jaata hai.

Link: **https://rkgarg-crm.pages.dev**

---

## Folder mein kya hai

| Folder / file | Kya hai |
|---|---|
| `public/index.html` | App ki screen (wahi purani screen, ab Cloudflare se) |
| `functions/api/[[path]].js` | `/api/...` requests ko server code tak bhejta hai |
| `src/` | Server ka saara logic (login, calls, visits, reports, legacy, sheet sync) |
| `schema.sql` | Database ki tables (ek baar D1 Console mein chalana hai) |
| `wrangler.toml` | Cloudflare settings (database ka link) |
| `apps-script/` | Google Sheet ke Apps Script mein daalne wali 2 files |
| `test/` | Testing ke liye (Cloudflare pe nahi chalta) |

---

## Setup (ek baar)

### 1. Database ki tables
Kuch nahi karna — app pehli baar chalte hi tables khud bana leta hai (`schema.sql` wali).

### 2. Cloudflare Pages se app live karo
1. **Workers & Pages → Create → Pages → Connect to Git**
2. GitHub connect karo, repo **rkgarg-crm** chuno
3. Project name: `rkgarg-crm`
4. Framework preset: **None** · Build command: *(khaali)* · Build output directory: `public`
5. **Save and Deploy**

### 3. Sync ka secret daalo
1. Pages project **rkgarg-crm → Settings → Variables and Secrets → Add**
2. Type: **Secret** · Name: `SYNC_KEY` · Value: *(chat mein diya hua lamba code)*
3. Save → **Deployments** → latest pe **⋯ → Retry deployment**

### 4. Google Sheet ke Apps Script mein
1. Sheet → **Extensions → Apps Script**
2. **+ → Script** → naam `CloudflareSync` → `apps-script/CloudflareSync.gs` ka content paste
3. **Setup.gs** ko `apps-script/Setup.gs` se badlo (menu mein Cloudflare buttons aate hain)
4. ⚙️ **Project Settings → Script Properties → Add**:
   - `CF_URL` = `https://rkgarg-crm.pages.dev`
   - `CF_SYNC_KEY` = wahi secret jo step 3 mein daala
5. Save, phir Sheet ko refresh karo

### 5. Test (purana app chalta rahega)
1. Sheet menu **Smart CRM → Cloudflare: 1) Sheet ka data app mein copy** → `COPY` likho
2. Naye link pe apne login se sab check karo (yahan ki entries baad mein dobara copy se mit jaayengi)

### 6. Asli shuruaat (shaam ko, jab koi kaam na kar raha ho)
1. Staff purana app band kare
2. Menu → **1) Sheet ka data app mein copy** dobara (taaza data)
3. Menu → **2) Sync chalu karo**
4. Staff ko naya link do. Purana Google app: Apps Script → **Deploy → Manage deployments → Archive**

> ⚠️ Sync chalu hone ke baad **purana Google app use mat karna**. Uski entries Sheet mein jaayengi par
> app mein nahi, aur 5 minute baad Sheet app ke data se overwrite ho jaayegi.

---

## Sheet ke niyam (sync chalu hone ke baad)
- Leads, CallLog, Users, Team, CRM Visits, LegacyReview mein cell badlo → kuch second mein app mein
- Leads mein neeche nayi row (Mobile + naam) → app mein naya customer, ID apne aap
- **Row delete ya sort mat karna** — delete/close app se karein, ya Status badlein
- **Password** Sheet se nahi badlega (Manage Users se)
- Koi badlav app mein nahi gaya toh us cell pe note aayega "App mein NAHI gaya: …"

## Speed / plan
Free Cloudflare plan abhi ke data ke liye kaafi hai. Agar kabhi screen pe "Server error … exceeded" aaye
(bahut bada data), toh Workers Paid plan ($5/mahina) le lein — code badalna nahi padega.

## Developer tests
```
npm test                         # API (47 checks) on local SQLite
node test/browser_test.js        # real index.html in a simulated browser
node test/sync_test.mjs          # Apps Script sync file against a local server
```

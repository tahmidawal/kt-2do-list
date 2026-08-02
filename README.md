# K & T 2do list

A shared list of things you two want to do — that tells you which one to actually do tonight,
based on where you each are, how far apart that is, and what the weather's doing in the middle.

## Running it

```bash
cd ~/kt-2do-list
./start
```

Then open **http://localhost:8420**.

First run only: copy `.env.example` to `.env` and paste in a Gemini API key
(get one at https://aistudio.google.com/apikey). Without it the list still
works, but adding ideas and picking a plan won't.

```bash
cp .env.example .env
# then edit .env and put your key in
```

Stop it with `Ctrl-C`.

## How to use it

**Add something** — write it however you'd say it out loud. "that ramen place on Queen, and
the botanical garden sometime" becomes two entries, each with a realistic time estimate,
whether it's indoor or outdoor, whether rain would ruin it, and roughly what it costs.

**What should we do?** — type where each of you is right now, optionally how much time you've
got, and it will:

- find the halfway point between you and work out the real driving time for each of you
- pull the actual forecast for that spot at that hour
- pick two or three things off your list that fit, and say why in plain English
- call out anything worth ruling out today

**Change photo** — put your own picture behind everything. Any JPG, PNG, or WebP.

## Where things live

```
kt-2do-list/
├── start              run this
├── .env               your API key (never committed)
├── backend/
│   ├── app.py         the web endpoints
│   ├── db.py          SQLite storage
│   ├── geo.py         geocoding, driving times, weather
│   └── llm.py         the two Gemini calls
├── static/            the page itself (HTML/CSS/JS, no build step)
└── data/kt.db         your list, on disk
```

Everything except Gemini is free and keyless: OpenStreetMap for looking up places, OSRM for
driving times, Open-Meteo for the forecast. Nothing about your list leaves the machine except
the activity names sent to Gemini when you ask it to pick something.

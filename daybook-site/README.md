# Daybook

A calendar + to-do app built for fast capture and at-a-glance checking.

Quick-add with natural language ("essay fri 3pm #uni"), an exact date/time
picker, Agenda / Month / History views, undo on delete, and a warm paper
theme. All data is saved in your browser via localStorage.

## Run it locally

You need Node.js installed (https://nodejs.org). Then, in this folder:

```
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173).

## Deploy to Vercel

### Option A — through GitHub (recommended, gives auto-updates)

1. Put this folder in a new GitHub repository.
2. Go to https://vercel.com and sign in with GitHub.
3. Click "Add New" then "Project", and import that repository.
4. Vercel auto-detects Vite. Leave the defaults:
   - Framework Preset: Vite
   - Build Command: npm run build
   - Output Directory: dist
5. Click "Deploy". You get a live URL in about a minute.

Every time you push a change to GitHub, Vercel redeploys automatically.

### Option B — straight from your computer (no GitHub)

1. Install Node.js if you have not already.
2. In this folder, run:

```
npm install -g vercel
vercel
```

3. Follow the prompts (log in, accept the defaults). The first run gives a
   preview URL. To publish the production URL, run:

```
vercel --prod
```

## Notes

- Tasks and history live in the browser's localStorage, so they stay on the
  device and browser you use. Clearing site data or using a different browser
  starts fresh.
- No build config to touch. The included vite.config.js and package.json are
  all Vercel needs.

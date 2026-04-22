"""Build a detailed, wrapped, single-linear GForce handover runbook PDF.

Fixes previous overflow by using XPreformatted inside code blocks so long
lines wrap on whitespace instead of bleeding off the page edge.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    XPreformatted,
    KeepTogether,
)

OUT = "GForce_Handover_Playbook.pdf"

PAGE_W = 210 * mm
LEFT = 18 * mm
RIGHT = 18 * mm
CONTENT_W = PAGE_W - LEFT - RIGHT
CODE_W = CONTENT_W - 2 * mm

styles = getSampleStyleSheet()

TITLE = ParagraphStyle(
    "Title2",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=20,
    leading=24,
    textColor=colors.HexColor("#12151d"),
    spaceAfter=6,
)
H1 = ParagraphStyle(
    "H1",
    parent=styles["Heading1"],
    fontName="Helvetica-Bold",
    fontSize=13,
    leading=17,
    textColor=colors.HexColor("#f37329"),
    spaceBefore=10,
    spaceAfter=5,
)
STEP = ParagraphStyle(
    "Step",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=11.5,
    leading=15,
    textColor=colors.HexColor("#12151d"),
    spaceBefore=8,
    spaceAfter=4,
)
BODY = ParagraphStyle(
    "Body2",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=10,
    leading=14,
    textColor=colors.HexColor("#12151d"),
    spaceAfter=4,
)
BULLET = ParagraphStyle(
    "Bul",
    parent=BODY,
    leftIndent=12,
    bulletIndent=2,
    spaceAfter=2,
)
SMALL = ParagraphStyle(
    "Small2",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=9,
    leading=12,
    textColor=colors.HexColor("#4f5663"),
    spaceAfter=3,
)
CODE = ParagraphStyle(
    "Code2",
    parent=styles["BodyText"],
    fontName="Courier",
    fontSize=8.6,
    leading=11,
    textColor=colors.HexColor("#12151d"),
    spaceAfter=0,
    leftIndent=0,
    rightIndent=0,
    wordWrap="CJK",
)
PROMPT_LABEL = ParagraphStyle(
    "PL",
    parent=BODY,
    fontName="Helvetica-Bold",
    fontSize=9.5,
    leading=12,
    textColor=colors.HexColor("#f37329"),
    spaceAfter=2,
)


def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items):
    return [Paragraph(f"• {t}", BULLET) for t in items]


def code_block(text):
    pre = XPreformatted(text, CODE)
    t = Table([[pre]], colWidths=[CODE_W])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f6f7f9")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#c9ced8")),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return t


def prompt(text):
    return KeepTogether([p("Paste into Claude Code:", PROMPT_LABEL), code_block(text)])


story = []

story.append(p("GForce App Handover Runbook", TITLE))
story.append(
    p(
        "One step-by-step guide for tomorrow's meeting. Follow in order from Step 1 to Step 12. "
        "Brooke, George, and Tuscany open this PDF side-by-side and complete each step together. "
        "<b>macOS only:</b> every shell command below is written for macOS Terminal (zsh). "
        "Do not paste them into Windows PowerShell or CMD.",
        SMALL,
    )
)
story.append(
    p(
        "Goal: move the GForce app from Brooke's accounts to GForce accounts, keep all existing flight data, "
        "keep current passwords (office123 and 1234), give Brooke Admin access for remote help, and confirm "
        "both sides can push updates to the live app.",
        SMALL,
    )
)

story.append(p("Plain-language system map", H1))
services = Table(
    [
        ["Service", "What it does"],
        ["GitHub", "Holds the app code and hosts the website people open on their phones."],
        ["Fly.io", "Runs the backend server (the part that handles logins, timers, flight saves)."],
        ["Turso", "Stores all live data (pilots, flights, timers, full history)."],
        ["Claude Code", "AI assistant used in Terminal to run commands and edits for you."],
    ],
    colWidths=[35 * mm, CONTENT_W - 35 * mm],
)
services.setStyle(
    TableStyle(
        [
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 9.5),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eceff4")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#c9ced8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]
    )
)
story.append(services)
story.append(Spacer(1, 4))
story.append(
    p(
        "<b>Keep unchanged:</b> office password <b>office123</b>, pilot password <b>1234</b>, and all existing flight data.",
        BODY,
    )
)

story.append(p("Step-by-step meeting flow", H1))

# ------------------ STEP 1 ------------------
story.append(p("Step 1 — Open this PDF on both laptops", STEP))
story.extend(
    bullets(
        [
            "On Brooke's laptop and George's laptop, open this PDF side-by-side.",
            "Do not skip ahead. Complete each step fully before moving on.",
            "Both laptops should be <b>Macs</b> with: <b>Terminal.app</b> open (default shell zsh), web browser open, password manager ready.",
        ]
    )
)

# ------------------ STEP 2 ------------------
story.append(p("Step 2 — Create required accounts (George's side)", STEP))
story.append(p("George must have accounts on all 4 services. Create any that are missing now:", BODY))
story.extend(
    bullets(
        [
            "<b>GitHub</b> — sign up at <font face='Courier'>https://github.com/join</font>. Note your username (needed later as GEORGE_USERNAME).",
            "<b>Fly.io</b> — sign up at <font face='Courier'>https://fly.io/app/sign-up</font>. Add a payment method (Fly requires one even for the small paid tier ~USD $5–7/month).",
            "<b>Turso</b> — sign up at <font face='Courier'>https://turso.tech</font>. Free tier is fine.",
            "<b>Anthropic (Claude)</b> — sign up at <font face='Courier'>https://claude.com</font>. Subscribe to Claude Pro or Max (needed for Claude Code).",
        ]
    )
)
story.append(p("Save all usernames and emails in the password manager as we create them.", SMALL))

# ------------------ STEP 3 ------------------
story.append(p("Step 3 — Install required command-line tools (George's Mac)", STEP))
story.append(
    p(
        "Open <b>Terminal.app</b> (macOS). Paste each block in order; skip anything already installed. "
        "Use a normal user account (not root).",
        BODY,
    )
)
story.append(
    code_block(
        "# 1) Install Homebrew (only if not installed):\n"
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n'
        "# 2) If `brew` says command not found after step 1, run ONE line (pick your Mac type):\n"
        "# Apple Silicon (M1/M2/M3/M4):\n"
        'echo \'eval "$(/opt/homebrew/bin/brew shellenv)"\' >> ~/.zprofile && eval "$(/opt/homebrew/bin/brew shellenv)"\n'
        "# Intel Mac — run this line instead of the Apple Silicon line above:\n"
        "echo 'eval \"$(/usr/local/bin/brew shellenv)\"' >> ~/.zprofile && eval \"$(/usr/local/bin/brew shellenv)\"\n\n"
        "# 3) Install Node.js (needed for Claude Code):\n"
        "brew install node\n\n"
        "# 4) Install Claude Code:\n"
        "npm install -g @anthropic-ai/claude-code\n\n"
        "# 5) Install GitHub CLI:\n"
        "brew install gh\n\n"
        "# 6) Install Fly.io CLI:\n"
        "curl -L https://fly.io/install.sh | sh\n\n"
        "# 7) If `fly` says command not found after step 6:\n"
        'export PATH="$HOME/.fly/bin:$PATH"\n'
        'grep -q \'\\.fly/bin\' ~/.zprofile 2>/dev/null || echo \'export PATH="$HOME/.fly/bin:$PATH"\' >> ~/.zprofile\n\n'
        "# 8) Install Turso CLI:\n"
        "curl -sSfL https://get.tur.so/install.sh | bash\n\n"
        "# 9) If `turso` is not found, open a new Terminal tab/window, or run: source ~/.zshrc"
    )
)
story.append(p("Then log into each CLI from the same Terminal window (or a new tab after PATH fixes):", BODY))
story.append(
    code_block(
        "gh auth login        # pick GitHub.com, HTTPS, browser login\n"
        "fly auth login       # opens browser to sign in\n"
        "turso auth login     # opens browser to sign in\n"
        "claude               # first run of Claude Code; will prompt login"
    )
)

# ------------------ STEP 4 ------------------
story.append(p("Step 4 — Verify everything is installed and logged in (via Claude Code)", STEP))
story.append(
    p(
        "In <b>Terminal.app</b> on George's Mac, start Claude Code and paste the prompt below. "
        "Claude will check all tools and logins.",
        BODY,
    )
)
story.append(p("Start Claude Code (macOS paths):", BODY))
story.append(code_block("mkdir -p ~/Developer && cd ~/Developer && claude"))
story.append(
    prompt(
        "Please verify my dev environment for the GForce handover.\n\n"
        "1) Print versions of: node, npm, git, gh, fly, turso.\n"
        "2) Check logins: gh auth status, fly auth whoami, turso auth whoami.\n"
        "3) If anything is missing or logged out, stop and print the exact macOS install or login command.\n"
        "4) Print my GitHub username, Fly.io email, Turso email so I can confirm they are George's accounts.\n"
        "5) When everything passes, print: READY FOR HANDOVER."
    )
)

# ------------------ STEP 5 ------------------
story.append(p("Step 5 — Transfer GitHub repo ownership (Brooke → George)", STEP))
story.extend(
    bullets(
        [
            "Brooke (in browser): go to <font face='Courier'>https://github.com/brookewhatnall/gforce-flight-log</font>.",
            "Click <b>Settings → General</b>, scroll to the bottom <b>Danger Zone</b>.",
            "Click <b>Transfer ownership</b>. Enter George's GitHub username. Confirm.",
            "George (in browser): open email / GitHub notifications, click <b>Accept transfer</b>.",
            "New repo URL will be <font face='Courier'>https://github.com/&lt;GEORGE_USERNAME&gt;/gforce-flight-log</font>.",
        ]
    )
)
story.append(p("Then verify in Claude Code:", BODY))
story.append(
    prompt(
        "GitHub ownership transfer should now be complete.\n\n"
        "Please verify by running:\n"
        "git ls-remote https://github.com/<GEORGE_USERNAME>/gforce-flight-log.git\n\n"
        "If it lists branches (including main), print: OWNERSHIP TRANSFER CONFIRMED.\n"
        "If it errors, stop and tell me what to check."
    )
)

# ------------------ STEP 6 ------------------
story.append(p("Step 6 — Give Brooke Admin access on the new repo", STEP))
story.extend(
    bullets(
        [
            "George (in browser): open the transferred repo under his account.",
            "Click <b>Settings → Collaborators and teams</b>.",
            "Click <b>Add people</b>. Enter Brooke's GitHub username (<font face='Courier'>brookewhatnall</font>).",
            "Choose <b>Admin</b> permission. Send invite.",
            "Brooke (in browser): open email / GitHub notifications, click <b>Accept invite</b>.",
            "This lets Brooke troubleshoot, push updates, and manage settings remotely.",
        ]
    )
)

# ------------------ STEP 7 ------------------
story.append(p("Step 7 — Clone repo onto George's laptop", STEP))
story.append(p("This puts a working copy on George's computer linked to his GitHub.", BODY))
story.append(
    prompt(
        "Please set up a local copy of the repo on my laptop.\n\n"
        "1) Run:\n"
        "mkdir -p ~/Developer && cd ~/Developer\n"
        "gh repo clone <GEORGE_USERNAME>/gforce-flight-log\n"
        "cd gforce-flight-log\n\n"
        "2) Show me:\n"
        "- git remote -v\n"
        "- git branch --show-current\n"
        "- git log --oneline -5\n\n"
        "3) Confirm the remote points to <GEORGE_USERNAME>/gforce-flight-log.\n"
        "Do NOT edit any files yet."
    )
)

# ------------------ STEP 8 ------------------
story.append(p("Step 8 — Deploy the backend on George's Fly.io account", STEP))
story.append(
    p(
        "Brooke shares secret values verbally / via password manager. Values must NOT be typed into this PDF, "
        "chat, or any file. Claude will ask for each value one-by-one and set it securely on Fly.",
        BODY,
    )
)
story.append(
    prompt(
        "Deploy the GForce API to my Fly.io account.\n\n"
        "1) cd ~/Developer/gforce-flight-log/api\n\n"
        "2) Ask me to pick APP_NAME:\n"
        "   - gforce-api (if available), OR\n"
        "   - gforce-api-nz (if the name is already taken).\n\n"
        "3) Run:\n"
        "fly launch --no-deploy --copy-config --name <APP_NAME> --region nrt --org personal\n\n"
        "4) Ask me to paste each secret value one at a time. Do not echo or log any value. Set each using:\n"
        "fly secrets set <NAME>=<value> --app <APP_NAME> --stage\n"
        "Secret names (ask in this order):\n"
        "- JWT_SECRET\n"
        "- OFFICE_PASSWORD   (use office123)\n"
        "- VAPID_PUBLIC_KEY\n"
        "- VAPID_PRIVATE_KEY\n"
        "- TURSO_URL         (Brooke's current value; will rotate in Step 9)\n"
        "- TURSO_AUTH_TOKEN  (Brooke's current value; will rotate in Step 9)\n"
        "- GITHUB_TOKEN      (optional; skip if not using CSV backups)\n"
        "- ALLOWED_ORIGINS=https://<GEORGE_USERNAME>.github.io\n\n"
        "5) Deploy:\n"
        "fly deploy --app <APP_NAME>\n\n"
        "6) Smoke test:\n"
        "curl -s https://<APP_NAME>.fly.dev/api/public/pilots | head -c 500\n"
        "Expected: JSON array of pilots.\n\n"
        "7) Print fly status --app <APP_NAME> and confirm one machine is running."
    )
)

# ------------------ STEP 9 ------------------
story.append(p("Step 9 — Move Turso database so all current flight data is preserved", STEP))
story.append(
    p(
        "Brooke dumps the live database, sends the file to George, George imports into his new Turso account, "
        "then Fly is pointed at the new database. Original data stays intact the whole time.",
        BODY,
    )
)
story.append(p("Brooke runs this on Brooke's Mac first (Terminal.app):", BODY))
story.append(
    code_block("turso db dump gforce-api-nzgforce --output ~/Desktop/gforce-backup.sql")
)
story.append(
    p(
        "The file appears on Brooke's <b>Desktop</b> in Finder. Brooke sends <font face='Courier'>gforce-backup.sql</font> "
        "to George (AirDrop Mac-to-Mac, Signal, or encrypted USB).",
        SMALL,
    )
)
story.append(
    prompt(
        "Migrate the Turso database to my Turso account.\n\n"
        "1) Ask me for the local path to gforce-backup.sql (for example ~/Downloads/gforce-backup.sql). Verify it exists and show size + first 20 lines.\n\n"
        "2) Create new DB in my Turso account:\n"
        "turso db create gforce-production --location nrt\n\n"
        "3) Import backup:\n"
        "turso db shell gforce-production < <PATH_TO_DUMP>\n\n"
        "4) Verify record counts (expect non-zero):\n"
        'turso db shell gforce-production "SELECT COUNT(*) AS pilots FROM pilots; SELECT COUNT(*) AS flights FROM flights;"\n\n'
        "5) Get new connection values:\n"
        "turso db show gforce-production --url\n"
        "turso db tokens create gforce-production\n\n"
        "6) Update Fly secrets to point at my new DB:\n"
        "fly secrets set TURSO_URL=<new-url> TURSO_AUTH_TOKEN=<new-token> --app <APP_NAME>\n\n"
        "7) Wait ~20 seconds then smoke test:\n"
        "curl -s https://<APP_NAME>.fly.dev/api/public/pilots\n"
        "Should still return the full pilot list — now from my DB.\n\n"
        "8) Print a final summary: DB name, record counts, hostname."
    )
)

# ------------------ STEP 10 ------------------
story.append(p("Step 10 — Update frontend + GitHub Actions auto-deploy", STEP))
story.append(
    p(
        "Fixes any hardcoded references to Brooke's URL, then sets the token GitHub needs to auto-deploy to Fly.",
        BODY,
    )
)
story.append(
    prompt(
        "Finalize frontend config and CI.\n\n"
        "1) In GitHub.com (I'll do this in browser): Settings → Pages. Confirm it builds from main branch, / (root) folder. Tell me the exact expected site URL.\n\n"
        "2) Search the repo for hardcoded references to Brooke's URLs:\n"
        'grep -rn "brookewhatnall.github.io" .\n'
        'grep -rn "gforce-api.fly.dev" .\n'
        "For each match, show me the file:line. Propose replacements:\n"
        "- brookewhatnall.github.io -> <GEORGE_USERNAME>.github.io\n"
        "- gforce-api.fly.dev -> <APP_NAME>.fly.dev (only if APP_NAME changed in Step 8)\n"
        "Wait for my approval before editing.\n\n"
        "3) Apply approved edits. Show diff, then:\n"
        "git add -A\n"
        'git commit -m "Update origins for ownership transfer"\n'
        "git push origin main\n\n"
        "4) Create a Fly deploy token and add it to GitHub Actions:\n"
        "fly tokens create deploy --name github-actions-gforce -x 999999h\n"
        "Then run:\n"
        'gh secret set FLY_API_TOKEN --body "<TOKEN_VALUE>" --repo <GEORGE_USERNAME>/gforce-flight-log\n\n'
        "5) Trigger a test deploy to confirm the token works:\n"
        "gh workflow run fly-deploy-api.yml\n"
        "gh run watch\n"
        "Report success or failure."
    )
)

# ------------------ STEP 11 ------------------
story.append(p("Step 11 — Run full end-to-end smoke test together", STEP))
story.extend(
    bullets(
        [
            "Open: <font face='Courier'>https://&lt;GEORGE_USERNAME&gt;.github.io/gforce-flight-log/</font> on a phone.",
            "Log in as a real pilot (use the test pilot Brooke provides). Enable push notifications if prompted.",
            "Log out, then log in as <b>— Office —</b> using office password <b>office123</b>.",
            "Send the test pilot away with a fake client name. Watch timer appear.",
            "Wait ~10 seconds, then click <b>Landed early</b>.",
            "Confirm the office dashboard shows the landing and the pilot's phone gets a push notification.",
            "Claude should tail <font face='Courier'>fly logs --app &lt;APP_NAME&gt;</font> the whole time.",
            'If everything works, say "HANDOVER LIVE" before moving on.',
        ]
    )
)

# ------------------ STEP 12 ------------------
story.append(p("Step 12 — Prove independent editing + deploy works, then cleanup plan", STEP))
story.append(
    p(
        "The final test: George (and later Brooke) can change the app and see it update live. "
        "After this, leave old systems running for 24–48 hours as a fallback before cleanup.",
        BODY,
    )
)
story.append(
    prompt(
        "Make a tiny safe change to prove editing and deploy works.\n\n"
        "1) Open version.json at repo root. Update the version to today's date + \"-handover\" (example: \"2026-04-23-handover\").\n"
        "2) Show me the diff.\n"
        "3) Commit and push:\n"
        "git add version.json\n"
        'git commit -m "Handover verification edit"\n'
        "git push origin main\n\n"
        "4) Wait ~60 seconds, then verify the live site:\n"
        "curl -s https://<GEORGE_USERNAME>.github.io/gforce-flight-log/version.json\n\n"
        "5) If curl returns the new version, print: HANDOVER COMPLETE.\n"
        "6) If not after 2 minutes, check Actions tab on GitHub for a pages-build-deployment run and report the status."
    )
)
story.append(p("Cleanup plan (Brooke does this 24–48 hours later, once stable):", BODY))
story.extend(
    bullets(
        [
            "Destroy Brooke's old Fly app: <font face='Courier'>fly apps destroy gforce-api</font>.",
            "Destroy Brooke's old Turso DB: <font face='Courier'>turso db destroy gforce-api-nzgforce</font>.",
            "Remove payment method from Brooke's Fly.io account.",
            "Archive old split repos on GitHub if any.",
        ]
    )
)

# ------------------ Secrets ref ------------------
story.append(p("Reference: secret names and what they mean", H1))
secrets = Table(
    [
        ["Name", "Meaning"],
        ["JWT_SECRET", "Signs login tokens so users stay logged in securely."],
        ["OFFICE_PASSWORD", "Office login password (keep as office123)."],
        ["VAPID_PUBLIC_KEY", "Public key for push notifications (do not change, or pilots lose push)."],
        ["VAPID_PRIVATE_KEY", "Private key paired with VAPID public key (do not change)."],
        ["GITHUB_TOKEN", "Optional token used for automated CSV backup commits."],
        ["TURSO_URL", "Database connection URL (updated in Step 9)."],
        ["TURSO_AUTH_TOKEN", "Database auth token (updated in Step 9)."],
        ["FLY_API_TOKEN", "GitHub Actions deploy token for Fly.io (set in Step 10)."],
        ["office123", "Current office login password — keep unchanged."],
        ["1234", "Current pilot password — keep unchanged."],
    ],
    colWidths=[45 * mm, CONTENT_W - 45 * mm],
)
secrets.setStyle(
    TableStyle(
        [
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
            ("FONT", (0, 1), (0, -1), "Courier", 9),
            ("FONT", (1, 1), (1, -1), "Helvetica", 9.4),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eceff4")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#c9ced8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
    )
)
story.append(secrets)
story.append(Spacer(1, 4))
story.append(
    p(
        "<b>Security:</b> this PDF only lists secret <i>names</i>. Share actual values in person via password manager.",
        SMALL,
    )
)

doc = SimpleDocTemplate(
    OUT,
    pagesize=A4,
    leftMargin=LEFT,
    rightMargin=RIGHT,
    topMargin=16 * mm,
    bottomMargin=16 * mm,
    title="GForce App Handover Runbook",
    author="Twisted Joker Limited",
)
doc.build(story)
print(f"Wrote: {OUT}")

"""Build GForce app user guide PDF."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

OUT = "GForce_App_User_Guide.pdf"

styles = getSampleStyleSheet()

TITLE = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=21,
    leading=25,
    textColor=colors.HexColor("#12151d"),
    spaceAfter=8,
)
H1 = ParagraphStyle(
    "H1",
    parent=styles["Heading1"],
    fontName="Helvetica-Bold",
    fontSize=14,
    leading=18,
    textColor=colors.HexColor("#f37329"),
    spaceBefore=10,
    spaceAfter=5,
)
H2 = ParagraphStyle(
    "H2",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=11,
    leading=14,
    textColor=colors.HexColor("#12151d"),
    spaceBefore=6,
    spaceAfter=3,
)
BODY = ParagraphStyle(
    "Body",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=10,
    leading=14,
    textColor=colors.HexColor("#12151d"),
    spaceAfter=4,
)
SMALL = ParagraphStyle(
    "Small",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=9,
    leading=12,
    textColor=colors.HexColor("#4f5663"),
    spaceAfter=3,
)
BUL = ParagraphStyle(
    "Bul",
    parent=BODY,
    leftIndent=12,
    bulletIndent=2,
    spaceAfter=2,
)


def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items):
    return [Paragraph(f"• {t}", BUL) for t in items]


story = []
story.append(p("GForce Flight Log — Features & User Guide", TITLE))
story.append(
    p(
        "Simple operational manual for pilots, office staff, and app administrators.",
        SMALL,
    )
)

story.append(p("1) What this app is", H1))
story.append(
    p(
        "GForce Flight Log is a single web app used for daily tandem paragliding operations. "
        "It has two modes inside the same URL: Pilot mode and Office mode.",
        BODY,
    )
)
story.append(
    p(
        "Live app URL: <font face='Courier'>https://gforceteam.github.io/gforce-flight-log/</font>",
        SMALL,
    )
)

story.append(p("2) What each system does", H1))
tbl = Table(
    [
        ["System", "Purpose"],
        ["Frontend (GitHub Pages)", "What users see and click in the browser or installed PWA."],
        ["Backend API (Fly.io)", "Handles logins, data saving, timers, and notifications."],
        ["Database (Turso)", "Stores pilots, flights, timers, and history data."],
        ["WebSocket", "Pushes real-time events between office and pilot screens."],
    ],
    colWidths=[45 * mm, 125 * mm],
)
tbl.setStyle(
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
story.append(tbl)

story.append(p("3) Core features list", H1))
story.append(p("Pilot features", H2))
story.extend(
    bullets(
        [
            "Pilot login with name + password.",
            "Flight logging (date, flight number, takeoff, landing, duration, notes).",
            "Edit or delete own flights.",
            "Availability toggle (signed in/signed out status).",
            "Wing registration update.",
            "Hours worked logging.",
            "Push notifications for office dispatch/timer events.",
            "View active flying timers and status.",
            "Drive logging (peak trip/drive records).",
            "Password change option.",
            "Works as installable PWA on phone.",
        ]
    )
)
story.append(p("Office features", H2))
story.extend(
    bullets(
        [
            "Office login via same app URL by selecting — Office —.",
            "Live pilot roster and real-time status board.",
            "Send Away (single pilot) with timer start.",
            "Group Send Away for multiple pilots.",
            "Timer controls: landed early, extend timer, cancel timer.",
            "Pilot sign in / sign out controls.",
            "View all office flights and edit/delete records.",
            "Reset pilot passwords from office panel.",
            "Exports and reporting screens.",
            "Auto-refresh fallback if live socket drops.",
        ]
    )
)

story.append(p("4) Day-to-day manual (non-technical)", H1))
story.append(p("Pilot workflow", H2))
story.extend(
    bullets(
        [
            "Open app URL on phone.",
            "Log in as your pilot name.",
            "Check status and assigned jobs.",
            "Log each completed flight accurately.",
            "Respond to office send-away instructions.",
            "Use Landed Early / timer actions when needed.",
            "Log out at end of shift.",
        ]
    )
)
story.append(p("Office workflow", H2))
story.extend(
    bullets(
        [
            "Open app URL and select — Office —.",
            "Enter office password to access office dashboard.",
            "Monitor pilot list and flight activity.",
            "Send pilots away with client names.",
            "Track timers and update landing status.",
            "Use group actions for busy periods.",
            "Review and correct records when needed.",
            "Reset pilot passwords if requested.",
        ]
    )
)

story.append(p("5) Admin / maintainer manual", H1))
story.extend(
    bullets(
        [
            "Source code repository: gforce-flight-log (GitHub).",
            "Frontend updates: push to main branch; GitHub Pages updates automatically.",
            "Backend updates: push API changes and deploy through Fly or CI workflow.",
            "Keep environment secrets in password manager, not in repo files.",
            "Monitor logs in Fly when debugging live issues.",
            "Keep Turso backups before any major migration or maintenance.",
        ]
    )
)

story.append(p("6) Important credentials (names only)", H1))
secrets = Table(
    [
        ["Name", "Used for"],
        ["JWT_SECRET", "Signs authentication tokens."],
        ["OFFICE_PASSWORD", "Office login password for dashboard access."],
        ["VAPID_PUBLIC_KEY", "Public key for web push notifications."],
        ["VAPID_PRIVATE_KEY", "Private key for web push notifications."],
        ["TURSO_URL", "Database connection address."],
        ["TURSO_AUTH_TOKEN", "Database authentication token."],
        ["GITHUB_TOKEN", "Optional token for backup-related automation."],
        ["FLY_API_TOKEN", "GitHub Actions deployment token for Fly."],
    ],
    colWidths=[45 * mm, 125 * mm],
)
secrets.setStyle(
    TableStyle(
        [
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 10),
            ("FONT", (0, 1), (0, -1), "Courier", 9),
            ("FONT", (1, 1), (1, -1), "Helvetica", 9.5),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eceff4")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#c9ced8")),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]
    )
)
story.append(secrets)
story.append(Spacer(1, 5))
story.append(
    p(
        "Security note: this guide lists secret names only. Keep actual values in password manager.",
        SMALL,
    )
)

story.append(p("7) Troubleshooting quick guide", H1))
story.extend(
    bullets(
        [
            "Login fails: verify correct mode (Pilot vs Office) and password.",
            "No live updates: refresh page, then check backend status/logs.",
            "No push notifications: check browser notification permissions and VAPID keys.",
            "Missing records: verify backend and database connection (Turso URL/token).",
            "Deploy not updating: check GitHub Actions status and Pages build status.",
        ]
    )
)

story.append(p("8) Ownership and support model", H1))
story.extend(
    bullets(
        [
            "Primary ownership can sit on GForce GitHub account.",
            "Brooke should remain collaborator (Admin) for remote troubleshooting when requested.",
            "Both sides can independently clone, edit, and push updates when authorized.",
        ]
    )
)

doc = SimpleDocTemplate(
    OUT,
    pagesize=A4,
    leftMargin=20 * mm,
    rightMargin=20 * mm,
    topMargin=16 * mm,
    bottomMargin=16 * mm,
    title="GForce Flight Log User Guide",
    author="Twisted Joker Limited",
)
doc.build(story)
print(f"Wrote: {OUT}")

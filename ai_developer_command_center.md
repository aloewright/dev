# AI Developer Command Center: Orchestration Overview

**App Type:** High-fidelity AI Orchestration & Developer Command Center.

**Vibe:** Professional, dark-themed, and technical. Minimalist layout with high-contrast elements, tailored for Cloudflare-native workflows.

**Screen: "Orchestration Overview" Dashboard**

### Layout & Navigation
- **Navigation Sidebar:** Vertical navigation with icons for "Global Pipeline," "Project Mappings," "Usage & Costs," and "Supervisor Settings." Status indicator dots (green/yellow/red) next to project names.
- **Global Header:** Displays real-time counters from the **Data Board**:
    - `Queued Runs`: [Count]
    - `Active Agents`: [Count]
    - `Open Linear Issues`: [Count]
    - `Completed (Today)`: [Count]

### Main Content: "Live Board"
- **Run Cards:** A grid of cards representing active agent runs. Each card includes:
    - **Repo & Objective:** GitHub repository path and the Linear issue title/objective.
    - **Pipeline Progress:** A progress stepper (Clone -> Analyze -> Plan -> Act -> Validate -> Land).
    - **Real-time Feed:** A 3-line terminal-style snippet showing the latest `run_event` or log output.
    - **Controls:** "Pause" and "Cancel" buttons on the card.

### Right Sidebar: "Supervisor Chat & Interventions"
- **Chat Interface:** A grounded chat panel for the **Supervisor Agent**.
    - **Input:** "Ask the supervisor about a run..."
    - **Messages:** AI-generated responses regarding project health, why a run failed, or cost summaries.
    - **Quick Actions:** Buttons to "Trigger Deploy," "Dispatch Fix Run," or "Redispatch Stuck Run."

### Bottom Drawer: "Platform Health"
- Collapsible section showing connectivity status for `Cloudflare D1`, `R2 Buckets`, `Linear OAuth`, and `GitHub App`.

**Stylistic Details:**
- **Color Palette:** Deep charcoal backgrounds (#121212), accent "Electric Blue" (#0070F3) for actions, and subtle gray borders (#333333).
- **Typography:** Clean sans-serif (Inter or similar). Mono-spaced font for log snippets.
- **Shape:** Softly rounded corners (8px) on all cards and buttons.
- **Borders:** 1px solid borders for defined structural separation.

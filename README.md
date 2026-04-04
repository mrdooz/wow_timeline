# WoW Log Timeline

Analyzes World of Warcraft combat logs from [WarcraftLogs](https://www.warcraftlogs.com/) and visualizes damage patterns, boss casts, and deaths on an interactive timeline.

## Setup

1. **Install dependencies**

   ```
   pip install -r requirements.txt
   ```

2. **Add WarcraftLogs API credentials**

   Create a `credentials.json` file in the project root with your [WarcraftLogs API client](https://www.warcraftlogs.com/api/clients):

   ```json
   {
       "client_id": "your-client-id",
       "client_secret": "your-client-secret"
   }
   ```

3. **Run the app**

   ```
   python app.py
   ```

   The app will start at `http://localhost:5000`.

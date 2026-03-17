# 🌐 CV Assistant (Web Edition)

> **Elevate your job hunt with AI-powered CV tailoring—streamlined, powerful, and total control.**

CV Assistant (Web Edition) is a premium, standalone tool that automates the "grunt work" of the job search. From scraping LinkedIn postings to rewriting your LaTeX bullets with surgical precision, this app handles the heavy lifting so you can focus on the interview.

---

## 🚀 The 60-Second Workflow

### 1. 🖱️ One-Click Scrape (Chrome Extension)
Don't copy-paste. Use our companion **Chrome Extension** to instantly pull job titles, companies, and descriptions directly from LinkedIn, Indeed, or any job board into your local CV Assistant database.
![Extension Scrape Demo](file:///d:/downloads/CV_customizer/docs/assets/capture_demo.png) *(Visualizing the bridge between browser and app)*

### 2. 🎯 Precision CV Tailoring
Paste your current LaTeX source and let the AI perform a **multi-pass ATS optimization**. 
- **Identify Gaps**: AI scans the JD for critical skills you're missing.
- **Strategic Rewrites**: It rewrites your bullet points to emphasize relevant experience without "hallucinating" new claims.
- **Split-Pane Review**: Compare changes side-by-side with localized red/green diffs. You have 100% approval control over every comma.

### 3. 📝 Grounded Cover Letters
Generate cover letters that aren't generic. Our engine uses your actual "Vault" data—stories and achievements you've saved—alongside the Job Description to create a letter that tells a consistent professional narrative.

### 4. 🤝 SAGA Interview Prep
Prepare for behavioral interviews with the **SAGA Assistant**:
- **Situation, Action, Goal, Achievement**: AI analyzes your tailored bullets and suggests how to answer "Tell me about a time..." questions using the SAGA framework.
- **Company Intelligence**: Integrated research modules (via Perplexity/Sonar) provide talking points about the company's recent news and culture.

---

## 🛠️ Advanced Features for Power Users

### 🧠 Model Choice & API Control
Choose your brain. We support **OpenAI (GPT-4o)** for high-precision or **OpenRouter** for maximum flexibility (Claude 3.5 Sonnet, DeepSeek, Llama 3).
- **Free vs. Paid**: OpenRouter offers free models (like DeepSeek-v3-Free), but please note: **Free models are significantly slower** and may have higher latency.
- **Hyperparameter Tuning**: Fine-tune Temperature and System Prompts in the Settings for more creative or strictly clinical rewrites.

### 📥 System Prompt Customization
Want your CV to sound more "Executive" or "Technical"? Edit the **System Prompts** directly within the app to change the AI's "personality" and tailoring strategy.

### 🏭 Batch Processing
Applying to 10 jobs at once? Queue them in the **Batch Launcher**. The app will process each job description, generate tailored drafts, and have them ready for your final review in the Dashboard.

### ⬇️ Portable & Private
- **Zero Local TeX Hassle**: No need to install MikTeX or TeX Live. We handle the production and you download the final `.tex` for easy external use or sharing.
- **Local Database**: All your data (Profiles/Vault/Jobs) stays on *your* machine in a local SQLite database.

---

## 🏁 How to Run
1. **Download** the portable `CV-Assistant-Web.exe`.
2. **Launch** and add your API Key in Settings.
3. **Connect** the Chrome Extension (pointing to `http://localhost:3000`).
4. **Dominate** your job hunt.

---
*Developed by [Abdullah Madoun](https://github.com/AbdullahMadoun)*

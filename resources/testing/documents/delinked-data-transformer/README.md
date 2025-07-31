# Delinked Data Transformer

A fully interactive tool for generating, transforming, dumping, and uploading test data for delinked performance testing. The tool guides you step-by-step, prompting for all actions and options to ensure safe and repeatable operation.

---

## 📦 Installation

Before running the tool for the first time, make sure you have [Node.js](https://nodejs.org/) installed.  
Then, install all required dependencies by running:

```bash
npm install

---

## 🚀 How to Run

1. Open a terminal and navigate to the `app` directory:
   ```bash
   cd resources/testing/documents/delinked-data-transformer/app
   ```
2. Start the tool:
   ```bash
   node index.js
   ```
3. Follow the on-screen prompts for each step.

---

## 🗂️ Workflow Overview

When you run `index.js`, you will be guided through these steps:

1. **Create dummy data file (optional)**
2. **Create dummy data records**
3. **Dump test tables**
4. **Transform files**
5. **Upload to DEV environment**

You can skip or repeat any step as needed.

---

## 1️⃣ Step 1: Create Dummy Data File

The tool will guide you through a series of prompts to generate dummy data files. No command-line arguments are required.

**Interactive prompts:**
1. **Create dummy records file? (y/n)**  
   - Default: **y**  
   - "n" skips dummy data creation.
2. **How many records to create?**  
   - Default: **250000**  
   - Enter your desired number of records.
3. **Create separate files? (y/n)**  
   - Default: **n**  
   - "y" generates three separate files (one per table); "n" generates a single combined file.
4. **Continue to create X dummy records (in separate files)? (y/n)**  
   - Default: **y**  
   - "n" lets you restart input or skip dummy data creation.

**Files generated:**
- **Single file (default):**  
  - `combined_inserts.sql` — All INSERT statements for all tables.
- **Separate files:**  
  - `organisations.sql` — Organisation INSERTs  
  - `delinkedCalculations.sql` — Delinked calculation INSERTs  
  - `d365.sql` — D365 INSERTs

**Data structure:**
- Organisations: SBI numbers starting at 123000000
- FRNs starting at 1234000000
- Calculation IDs starting at 987000000
- Payment references in format `PY0000001`
- Standard payment amounts and band values
- Current timestamps for dates

> **Tip:** You can always skip, restart, or confirm before any data is generated. All options are prompted interactively for safety and ease of use.

---

## 🛠️ Advanced: Command-Line Usage

You may also run the dummy data generator directly (outside the main app) if you wish:

- **Generate SQL file with 50,000 records:**
  ```bash
  node create-dummy-file.js 50000
  ```
- **Generate separate SQL files with 10,000 records:**
  ```bash
  node create-dummy-file.js 10000 true
  ```

> For most users, the interactive workflow is recommended.

---

## ⚡ Performance Considerations

- Data is generated in batches of 10,000 records for memory efficiency.
- For very large datasets, generating SQL files (rather than direct DB insertion) is preferable for manual control.

---

## 2️⃣ Step 2: Dump Test Tables

- **Prompt:** "Run dump step? (y/n)"
- If "y", the script exports the current state of test tables from the database into SQL files.
- Useful for backing up or reviewing test data before transformation.

---

## 3️⃣ Step 3: Transform Files

- **Prompt:** "Run transform step? (y/n)"
- If "y", the script processes the dumped SQL files, applying any required transformations to the data or schema.
- Prepares the data for upload to the DEV environment.

---

## 4️⃣ Step 4: Upload to DEV Environment

- **Prompt:** "Which upload would you like to run?"
  - 1. `ffc-pay`
  - 2. `ffc-doc`
  - 3. `all` (both)
  - 4. `none` (skip upload)
- After selecting, you are asked:
  - **"Run as dry-run first? (y/n)"**
    - "y" simulates the upload and shows what would happen, without making changes.
    - You are then asked if you want to perform a live upload.
    - "n" performs the live upload immediately.
- After each upload, you are asked if you want to run another upload.

---

## 🛡️ Safety and Error Handling

- Each step uses a `safeRun` wrapper, catching errors and prompting you to retry if something fails.
- You can skip any step at any time.
- The tool never proceeds to the next step without your confirmation.

---

## 📝 Summary

- **Fully interactive:** All options and actions are prompted; no command-line arguments are required.
- **Safe for new users:** You can skip, repeat, or confirm every step.
- **Flexible:** Dummy data generation, transformation, dumping, and upload are all handled in sequence, with the ability to skip or repeat steps as needed.

---

For more details on the structure of the generated files or the specifics of the data, see the code in the `dummy-data-creation`, `database`, `transform
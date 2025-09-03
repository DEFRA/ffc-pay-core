# ERD Extraction Tool - extract-schema.js

## Overview

The `extract-schema.js` script is a Node.js utility designed to extract database schema information from Sequelize model files and generate Entity Relationship Diagrams (ERDs) in both JSON and Draw.io formats. It automates the process of visualizing database structures by parsing model definitions, inferring relationships, and producing editable diagram files.

## Purpose

This tool serves the following purposes:

- **Schema Extraction**: Automatically parse Sequelize model files to extract table structures, columns, data types, constraints, and relationships.
- **ERD Generation**: Create visual representations of database schemas using Draw.io compatible XML files.
- **JSON Output**: Produce structured JSON files containing detailed schema information for further processing or documentation.
- **Relationship Inference**: Automatically detect and visualize foreign key relationships between tables based on naming conventions.

## Prerequisites

- Node.js installed on the system
- Sequelize model files in a `models/` directory relative to the script
- (Optional) Draw.io application for editing generated diagrams

## Installation

No installation is required. Simply ensure the `extract-schema.js` file is present in your project directory.

## Usage

### Default Mode: Extract from Models Directory

To extract schema from Sequelize model files in the default `models/` directory:

1. Navigate to the directory containing the `extract-schema.js` script.
2. Ensure a `models/` directory exists with Sequelize model files (`.js` files).
3. Run the script:

```bash
node extract-schema.js
```

This will:

- Scan all `.js` files in the `models/` directory
- Parse Sequelize model definitions
- Generate two output files:
  - `{repo-name}-erd.json`: JSON representation of the schema
  - `{repo-name}-erd.drawio`: Draw.io XML file for the ERD

### File Mode: Generate Draw.io from Existing JSON

To generate a Draw.io diagram from an existing JSON schema file:

```bash
node extract-schema.js -file <path-to-json-file>
```

#### Examples:

- Single JSON file:
  ```bash
  node extract-schema.js -file ./my-schema.json
  ```

- Directory containing JSON files:
  ```bash
  node extract-schema.js -file ./json-schemas/
  ```

- Multiple files:
  ```bash
  node extract-schema.js -file file1.json,file2.json
  ```

- WSL path (for Windows Subsystem for Linux):
  ```bash
  node extract-schema.js -file /mnt/c/Users/me/Documents/schema.json
  ```

### Command Line Options

- `-file, --file <path>`: Path to JSON file(s) or directory to convert to Draw.io format
- `-h, --help`: Display help information

### Environment Variables

- `REPO_NAME`: Override the default repository name used in output file names

## Output Files

### JSON Schema File (`{repo-name}-erd.json`)

Contains:

- `generatedAt`: Timestamp of generation
- `models`: Array of model objects with:
  - `name`: Model/table name
  - `fields`: Object with field names as keys and field properties as values
    - `type`: Data type (e.g., "STRING", "INTEGER", "DATE")
    - `allowNull`: Boolean indicating if null values are allowed
    - `primaryKey`: Boolean indicating primary key
    - `autoIncrement`: Boolean for auto-incrementing fields
    - `defaultValue`: Default value if any
    - `unique`: Boolean for unique constraints
- `errors`: Array of any errors encountered during parsing
- `relationships`: Inferred relationships between models

### Draw.io File (`{repo-name}-erd.drawio`)

An XML file that can be opened directly in Draw.io (or diagrams.net) containing:

- Visual representation of tables as rectangles
- Columns listed within each table
- Primary key indicators (PK labels)
- Inferred relationships shown as connecting lines
- Automatic layout with proper spacing

## How It Works

1. **Model Discovery**: Scans the `models/` directory for `.js` files
2. **Model Parsing**: Uses a fake Sequelize environment to execute model definitions without database connection
3. **Attribute Extraction**: Parses Sequelize data types and constraints
4. **Relationship Inference**: Detects relationships based on field naming patterns (e.g., `userId` implies relationship to `User` model)
5. **JSON Generation**: Creates structured JSON output
6. **Draw.io XML Generation**: Converts schema to Draw.io compatible XML with:
   - Table positioning and sizing
   - Field layout within tables
   - Relationship arrows and connections
   - Proper XML escaping for special characters

## Error Handling

The script handles various error scenarios:

- Missing `models/` directory
- Invalid model file syntax
- Unsupported model export formats
- File I/O errors

Errors are logged to the console and included in the JSON output under the `errors` array.

## Limitations

- Only supports Sequelize model definitions
- Relationship inference is based on naming conventions
- Complex relationships may require manual adjustment in Draw.io
- Does not connect to actual databases (works with model definitions only)

## Troubleshooting

### Common Issues

1. **"Models directory not found"**
   - Ensure you're running the script from the correct directory
   - Verify the `models/` directory exists and contains `.js` files

2. **"Unsupported module export type"**
   - Check that model files export valid Sequelize models
   - Ensure models are defined using `sequelize.define()` or similar

3. **Empty output**
   - Verify model files have proper Sequelize syntax
   - Check for syntax errors in model definitions

### Getting Help

Run the script with the help flag:

```bash
node extract-schema.js --help
```

## Examples

### Basic Usage

```bash
# In a project with models/ directory
node extract-schema.js
# Outputs: my-project-erd.json and my-project-erd.drawio
```

### Custom Repository Name

```bash
REPO_NAME=my-custom-name node extract-schema.js
# Outputs: my-custom-name-erd.json and my-custom-name-erd.drawio
```

### Converting Existing Schema

```bash
node extract-schema.js -file /path/to/existing-schema.json
# Outputs: existing-schema.drawio
```

## Contributing

To modify or extend the script:

1. Edit `extract-schema.js`
2. Test with sample model files
3. Verify output JSON and Draw.io files

The script is self-contained and has no external dependencies beyond Node.js built-in modules.

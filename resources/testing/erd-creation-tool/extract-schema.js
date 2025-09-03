'use strict'

/*
  app/data/export-schema.js

  Usage:
    # Optionally set REPO_NAME to override repo-derived name
    REPO_NAME=ffc-demo-system node app/data/export-schema.js

  Additional usage with -file:
    # Generate drawio from existing JSON files:
    node resources/testing/erd-creation-tool/extract-2.js -file /path/to/file.json
    node resources/testing/erd-creation-tool/extract-2.js --file /path/to/dir-with-jsons
    node resources/testing/erd-creation-tool/extract-2.js -file "C:\path\to\file.json"   # WSL will convert C:\... to /mnt/c/...
    node resources/testing/erd-creation-tool/extract-2.js -file file1.json,file2.json

  This script:
   - Loads each JS file in app/data/models (default mode)
   - Or, when -file is supplied, reads existing JSON files and generates .drawio outputs next to each JSON
*/

const fs = require('fs').promises
const path = require('path')

const MODELS_DIR = path.join(__dirname, 'models')

const repoRoot = path.resolve(__dirname, '..', '..')
const repoNameFromFs = path.basename(repoRoot) || 'export'
const repoName = process.env.REPO_NAME ? String(process.env.REPO_NAME).trim() : repoNameFromFs
const OUTPUT_JSON = path.join(__dirname, `${repoName}-erd.json`)
const OUTPUT_DRAWIO = path.join(__dirname, `${repoName}-erd.drawio`)

const makeFakeDataTypes = () => {
  return new Proxy(
    {},
    {
      get (_target, prop) {
        const f = (...args) => {
          if (args.length > 0) return { _type: String(prop), args }
          return { _type: String(prop) }
        }
        Object.defineProperty(f, '_type', { value: String(prop), enumerable: false })
        f.toString = () => String(prop)
        return f
      }
    }
  )
}

const makeFakeSequelize = (capture) => ({
  define (name, attributes, options) {
    capture.models.push({ name, attributes, options: options || {} })
    return { name, rawAttributes: attributes, options: options || {} }
  },
  Sequelize () {},
  transaction: async () => ({ commit: async () => {}, rollback: async () => {} })
})

const normalizeAttribute = (attrVal) => {
  const result = {}
  if (attrVal == null) return result

  if (typeof attrVal === 'function' && attrVal._type) {
    result.type = String(attrVal._type)
    return result
  }

  if (typeof attrVal === 'object' && attrVal._type) {
    result.type = Array.isArray(attrVal.args) && attrVal.args.length > 0
      ? `${attrVal._type}(${attrVal.args.join(',')})`
      : String(attrVal._type)
    return result
  }

  if (typeof attrVal === 'object' && attrVal.type) {
    const t = attrVal.type
    if (typeof t === 'function' && t._type) {
      result.type = String(t._type)
    } else if (typeof t === 'object' && t._type) {
      result.type = Array.isArray(t.args) && t.args.length > 0
        ? `${t._type}(${t.args.join(',')})`
        : String(t._type)
    } else {
      result.type = String(t)
    }

    const flags = ['allowNull', 'primaryKey', 'autoIncrement', 'defaultValue', 'unique']
    flags.forEach((f) => {
      if (Object.prototype.hasOwnProperty.call(attrVal, f)) result[f] = attrVal[f]
    })
    return result
  }

  result.type = String(attrVal)
  return result
}

const extractModelInfo = (modelEntry) => {
  const { name, attributes } = modelEntry
  const fields = {}
  if (attributes && typeof attributes === 'object') {
    Object.keys(attributes).forEach((attrName) => {
      try {
        fields[attrName] = normalizeAttribute(attributes[attrName])
      } catch (err) {
        fields[attrName] = { error: String(err) }
      }
    })
  }
  return { name, fields }
}

const getModelFiles = async (dir) => {
  const names = await fs.readdir(dir)
  return names.filter((n) => n.endsWith('.js')).map((n) => path.join(dir, n))
}

const loadModelFile = async (filePath, capture) => {
  try {
    const modelModule = require(filePath)
    const fakeDataTypes = makeFakeDataTypes()
    const fakeSequelize = makeFakeSequelize(capture)

    if (typeof modelModule === 'function') {
      try {
        modelModule(fakeSequelize, fakeDataTypes)
      } catch (err) {
        try {
          modelModule(fakeSequelize)
        } catch (err2) {
          capture.errors.push({ file: filePath, error: String(err2) })
        }
      }
    } else if (typeof modelModule === 'object' && modelModule !== null) {
      if (modelModule.name && modelModule.attributes) {
        capture.models.push({ name: modelModule.name, attributes: modelModule.attributes })
      } else {
        const baseName = path.basename(filePath, '.js')
        capture.models.push({ name: baseName, attributes: modelModule })
      }
    } else {
      capture.errors.push({ file: filePath, error: 'Unsupported module export type' })
    }
  } catch (err) {
    capture.errors.push({ file: filePath, error: String(err) })
  }
}

const inferRelationships = (models) => {
  const byName = {}
  models.forEach((m) => { byName[m.name.toLowerCase()] = m })

  const relationships = []
  models.forEach((m) => {
    const fields = m.fields || {}
    Object.keys(fields).forEach((fName) => {
      if (fName.toLowerCase().endsWith('id') && fName.length > 2) {
        const prefix = fName.slice(0, -2).toLowerCase()
        if (byName[prefix]) {
          relationships.push({
            fromModel: m.name,
            fromField: fName,
            toModel: byName[prefix].name,
            toField: Object.keys(byName[prefix].fields || {})[0] || `${prefix}Id`
          })
        }
      }
    })
  })
  return relationships
}

const generateDrawioXml = (data) => {
  const xmlEscape = (s) => {
    if (s == null) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&apos;')
      .replace(/"/g, '&quot;')
  }

  const models = data.models || []
  const relationships = inferRelationships(models)

  const total = models.length
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)))
  const marginX = 60
  const marginY = 60
  const gapX = 80
  const gapY = 60
  const maxColWidth = 380

  const modelSizes = models.map((m) => {
    const fieldCount = Object.keys(m.fields || {}).length
    const height = Math.max(48, 30 + fieldCount * 30)
    const width = Math.min(300, maxColWidth)
    return { name: m.name, width, height, fields: m.fields }
  })

  const rows = Math.max(1, Math.ceil(total / cols))
  const colWidths = new Array(cols).fill(0)
  const rowHeights = new Array(rows).fill(0)

  modelSizes.forEach((ms, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    if (ms.width > colWidths[col]) colWidths[col] = ms.width
    if (ms.height > rowHeights[row]) rowHeights[row] = ms.height
  })

  const xOffsets = new Array(cols).fill(0)
  for (let c = 0; c < cols; c += 1) {
    if (c === 0) xOffsets[c] = marginX
    else xOffsets[c] = xOffsets[c - 1] + colWidths[c - 1] + gapX
  }

  const yOffsets = new Array(rows).fill(0)
  for (let r = 0; r < rows; r += 1) {
    if (r === 0) yOffsets[r] = marginY
    else yOffsets[r] = yOffsets[r - 1] + rowHeights[r - 1] + gapY
  }

  const modelPositions = modelSizes.map((ms, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = xOffsets[col]
    const y = yOffsets[row]
    const width = colWidths[col] || ms.width
    const height = rowHeights[row] || ms.height
    return { name: ms.name, x, y, width, height, fields: ms.fields }
  })

  let cellId = 62
  const idForModel = {}
  const idForField = {}
  const idForFieldPos = {}
  const cells = []

  cells.push('<mxCell id="0" />')
  cells.push('<mxCell id="1" parent="0" />')

  modelPositions.forEach((mp) => {
    cellId += 1
    const parentId = `cell_${cellId}`
    idForModel[mp.name] = parentId

    const tableStyle = 'shape=table;startSize=30;container=1;collapsible=1;childLayout=tableLayout;fixedRows=1;rowLines=0;fontStyle=1;align=center;resizeLast=1;fillColor=#dae8fc;strokeColor=#6c8ebf;rounded=1;swimlaneLine=1;bottom=1;'
    cells.push(`<mxCell id="${parentId}" value="${xmlEscape(mp.name)}" style="${xmlEscape(tableStyle)}" vertex="1" parent="1">`)
    cells.push(`<mxGeometry x="${mp.x}" y="${mp.y}" width="${mp.width}" height="${mp.height}" as="geometry" />`)
    cells.push('</mxCell>')

    cellId += 1
    const headerRowId = `r_${cellId}`
    const headerPartialStyle = 'shape=partialRectangle;collapsible=0;dropTarget=0;pointerEvents=0;fillColor=none;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;top=0;left=0;right=0;bottom=1;'
    cells.push(`<mxCell id="${headerRowId}" value="" style="${xmlEscape(headerPartialStyle)}" vertex="1" parent="${parentId}">`)
    cells.push(`<mxGeometry y="30" width="${mp.width}" height="30" as="geometry" />`)
    cells.push('</mxCell>')

    const fieldNames = Object.keys(mp.fields || {})
    const rowY = 30
    idForField[mp.name] = idForField[mp.name] || {}
    idForFieldPos[mp.name] = idForFieldPos[mp.name] || {}
    fieldNames.forEach((fn, idx) => {
      const f = mp.fields[fn] || {}
      cellId += 1
      const rowContainerId = `r_${cellId}`
      const rowTop = mp.y + rowY + (idx * 30)
      const rowLeft = mp.x
      const rowWidth = mp.width
      const rowHeight = 30
      cells.push(`<mxCell id="${rowContainerId}" value="" style="${xmlEscape(headerPartialStyle)}" vertex="1" parent="${parentId}">`)
      cells.push(`<mxGeometry y="${rowY + (idx * 30)}" width="${mp.width}" height="30" as="geometry" />`)
      cells.push('</mxCell>')

      idForField[mp.name][fn] = rowContainerId
      idForFieldPos[mp.name][fn] = { x: rowLeft, y: rowTop, width: rowWidth, height: rowHeight }

      if (f.primaryKey) {
        cellId += 1
        const pkCellId = `pk_${cellId}`
        const pkStyle = 'shape=partialRectangle;overflow=hidden;connectable=0;fillColor=none;top=0;left=0;bottom=0;right=0;fontStyle=1;'
        cells.push(`<mxCell id="${pkCellId}" value="PK" style="${xmlEscape(pkStyle)}" vertex="1" parent="${rowContainerId}">`)
        cells.push('<mxGeometry width="30" height="30" as="geometry"><mxRectangle width="30" height="30" as="alternateBounds"/></mxGeometry>')
        cells.push('</mxCell>')
      } else {
        cellId += 1
        const placeholderId = `ph_${cellId}`
        const phStyle = 'shape=partialRectangle;overflow=hidden;connectable=0;fillColor=none;top=0;left=0;bottom=0;right=0;fontStyle=1;'
        cells.push(`<mxCell id="${placeholderId}" value="" style="${xmlEscape(phStyle)}" vertex="1" parent="${rowContainerId}">`)
        cells.push('<mxGeometry width="30" height="30" as="geometry"><mxRectangle width="30" height="30" as="alternateBounds"/></mxGeometry>')
        cells.push('</mxCell>')
      }

      cellId += 1
      const fieldCellId = `f_${cellId}`
      const fieldVal = `${fn} ${f.type ? f.type : ''}`.trim()
      const fieldStyle = 'shape=partialRectangle;overflow=hidden;connectable=0;fillColor=none;top=0;left=0;bottom=0;right=0;align=left;spacingLeft=6;fontStyle=5;'
      cells.push(`<mxCell id="${fieldCellId}" value="${xmlEscape(fieldVal)}" style="${xmlEscape(fieldStyle)}" vertex="1" parent="${rowContainerId}">`)
      const fieldWidth = Math.max(30, mp.width - 30)
      cells.push(`<mxGeometry x="30" width="${fieldWidth}" height="30" as="geometry"><mxRectangle width="${fieldWidth}" height="30" as="alternateBounds"/></mxGeometry>`)
      cells.push('</mxCell>')
    })
  })

  const edgeStyleBase = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;'

  relationships.forEach((rel) => {
    cellId += 1
    const edgeId = `e_${cellId}`
    const sourceId = (idForField[rel.fromModel] && idForField[rel.fromModel][rel.fromField]) || idForModel[rel.fromModel]
    const targetId = (idForField[rel.toModel] && idForField[rel.toModel][rel.toField]) || idForModel[rel.toModel]

    const sourcePos = (idForFieldPos[rel.fromModel] && idForFieldPos[rel.fromModel][rel.fromField]) || null
    const targetPos = (idForFieldPos[rel.toModel] && idForFieldPos[rel.toModel][rel.toField]) || null

    let exitX = 0.5
    let exitY = 1
    let entryX = 0.5
    let entryY = 0

    if (sourcePos && targetPos) {
      const sLeft = sourcePos.x
      const sRight = sourcePos.x + sourcePos.width
      const sTop = sourcePos.y
      const sBottom = sourcePos.y + sourcePos.height
      const tLeft = targetPos.x
      const tRight = targetPos.x + targetPos.width
      const tTop = targetPos.y
      const tBottom = targetPos.y + targetPos.height

      if (sRight < tLeft) {
        exitX = 1
        exitY = 0.5
        entryX = 0
        entryY = 0.5
      } else if (sLeft > tRight) {
        exitX = 0
        exitY = 0.5
        entryX = 1
        entryY = 0.5
      } else if (sBottom < tTop) {
        exitX = 0.5
        exitY = 1
        entryX = 0.5
        entryY = 0
      } else if (sTop > tBottom) {
        exitX = 0.5
        exitY = 0
        entryX = 0.5
        entryY = 1
      } else {
        exitX = 1
        exitY = 0.5
        entryX = 0
        entryY = 0.5
      }
    } else {
      exitX = 0.5
      exitY = 1
      entryX = 0.5
      entryY = 0
    }

    const style = `${edgeStyleBase}exitX=${exitX};exitY=${exitY};exitDx=0;exitDy=0;entryX=${entryX};entryY=${entryY};entryDx=0;entryDy=0;`
    cells.push(`<mxCell id='${edgeId}' style='${xmlEscape(style)}' edge='1' parent='1' source='${sourceId}' target='${targetId}'>`)
    cells.push('<mxGeometry relative="1" as="geometry" />')
    cells.push('</mxCell>')
  })

  const cellsXml = cells.join('\n        ')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="Electron" agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) draw.io/27.0.9 Chrome/134.0.6998.205 Electron/35.4.0 Safari/537.36" version="27.0.9">
  <diagram name="Page-1" id="erd-ltr">
    <mxGraphModel dx="-651" dy="-275" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
      <root>
        ${cellsXml}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`

  return xml
}

const windowsToWsl = (p) => {
  if (!p) return p
  p = p.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  const winDriveMatch = p.match(/^([A-Za-z]):\\(.*)/)
  if (winDriveMatch) {
    const drive = winDriveMatch[1].toLowerCase()
    const rest = winDriveMatch[2].replace(/\\/g, '/')
    return `/mnt/${drive}/${rest}`
  }
  const winDriveMatch2 = p.match(/^([A-Za-z]):\/(.*)/)
  if (winDriveMatch2) {
    const drive = winDriveMatch2[1].toLowerCase()
    const rest = winDriveMatch2[2].replace(/\\/g, '/')
    return `/mnt/${drive}/${rest}`
  }
  return p
}

const parseCliArgs = () => {
  const args = process.argv.slice(2)
  const result = { files: [], help: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-file' || a === '--file' || a === '-f') {
      const val = args[i + 1]
      if (!val) {
        console.error('Missing value for -file')
        process.exitCode = 2
        return result
      }
      i += 1
      const parts = String(val).split(',').map((s) => s.trim()).filter(Boolean)
      result.files.push(...parts)
    } else if (a.startsWith('--file=')) {
      const val = a.split('=')[1]
      const parts = String(val).split(',').map((s) => s.trim()).filter(Boolean)
      result.files.push(...parts)
    } else if (a === '-h' || a === '--help') {
      result.help = true
    }
  }
  return result
}

const printHelp = () => {
  console.log('Usage:')
  console.log('  node extract-2.js                # discover models in models/ and generate JSON + drawio (existing behavior)')
  console.log('  node extract-2.js -file <path>   # generate drawio(s) from existing JSON file(s) or directory')
  console.log('')
  console.log('Examples:')
  console.log('  node extract-2.js -file ./my-repo-erd.json')
  console.log('  node extract-2.js -file ./json-dir')
  console.log('  node extract-2.js -file file1.json,file2.json')
  console.log('  node extract-2.js -file "C:\\Users\\me\\Downloads\\my-erd.json"  # WSL-friendly')
}

const generateDrawioForJsonFile = async (jsonPath) => {
  try {
    const content = await fs.readFile(jsonPath, 'utf8')
    const data = JSON.parse(content)
    const xml = generateDrawioXml(data)
    const outPath = path.join(path.dirname(jsonPath), `${path.basename(jsonPath, '.json')}.drawio`)
    await fs.writeFile(outPath, xml, 'utf8')
    console.log(`Generated drawio: ${outPath}`)
  } catch (err) {
    console.error(`Failed to generate drawio for ${jsonPath}: ${err && err.message ? err.message : err}`)
  }
}

const run = async () => {
  const cli = parseCliArgs()
  if (cli.help) {
    printHelp()
    return
  }

  if (cli.files && cli.files.length > 0) {
    const resolvedList = []
    for (const raw of cli.files) {
      let p = raw
      p = windowsToWsl(p)
      if (!path.isAbsolute(p)) p = path.resolve(process.cwd(), p)
      try {
        const st = await fs.stat(p).catch(() => null)
        if (!st) {
          console.warn(`Path not found: ${raw} -> tried ${p}`)
          continue
        }
        if (st.isDirectory()) {
          const names = await fs.readdir(p)
          for (const n of names) {
            if (n.toLowerCase().endsWith('.json')) resolvedList.push(path.join(p, n))
          }
        } else {
          if (p.toLowerCase().endsWith('.json')) resolvedList.push(p)
          else console.warn(`Skipping non-json file: ${p}`)
        }
      } catch (err) {
        console.warn(`Failed to stat path ${p}: ${err && err.message ? err.message : err}`)
      }
    }

    if (resolvedList.length === 0) {
      console.warn('No JSON files found for provided -file paths.')
      return
    }

    for (const j of resolvedList) {
      await generateDrawioForJsonFile(j)
    }
    return
  }

  const capture = { models: [], errors: [] }
  try {
    const stats = await fs.stat(MODELS_DIR).catch(() => null)
    if (!stats || !stats.isDirectory()) {
      console.error(`Models directory not found: ${MODELS_DIR}`)
      process.exitCode = 2
      return
    }

    const files = await getModelFiles(MODELS_DIR)

    for (const f of files) {
      const abs = path.resolve(f)
      delete require.cache[abs]
      await loadModelFile(abs, capture)
    }

    const output = {
      generatedAt: new Date().toISOString(),
      models: capture.models.map(extractModelInfo),
      errors: capture.errors
    }

    await fs.writeFile(OUTPUT_JSON, JSON.stringify(output, null, 2), 'utf8')
    console.log(`Exported schema JSON saved to: ${OUTPUT_JSON}`)

    try {
      const xml = generateDrawioXml(output)
      await fs.writeFile(OUTPUT_DRAWIO, xml, 'utf8')
      console.log(`Exported draw.io file saved to: ${OUTPUT_DRAWIO}`)
    } catch (ex) {
      console.warn(`Failed to generate draw.io xml: ${ex}`)
    }

    if (capture.errors && capture.errors.length > 0) console.warn('Some model files produced errors while loading. Check the "errors" field in the JSON output.')
  } catch (err) {
    console.error(`Failed to export schema: ${err.stack || err}`)
    process.exitCode = 1
  }
}

if (require.main === module) run()

module.exports = { run }

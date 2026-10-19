// Real browser File/DOMParser/PDF.js worker and real Office ZIP/PDF fixtures.
// No model, account, external file, or network provider calls.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import pptxgen from 'pptxgenjs'
import { jsPDF } from 'jspdf'
import sharp from 'sharp'
import { Document, Packer, Paragraph, Table, TableRow, TableCell } from 'docx'
const root=fileURLToPath(new URL('../client',import.meta.url)),output=process.env.OUTPUT_DIR||'/tmp/nalu-attachment-extraction'
await mkdir(output,{recursive:true})
const fixtures=[],add=(name,type,bytes,range)=>fixtures.push({name,type,data:Buffer.from(bytes).toString('base64'),range})
const png=await sharp({create:{width:30,height:20,channels:4,background:'#b62749'}}).png().toBuffer()
add('actual-image.png','image/png',png)
add('broken-image.png','image/png',Buffer.from('not an image'))
add('note.txt','text/plain',Buffer.from('Actual input: paid invoice 12345.'))
add('binary.txt','text/plain',Buffer.from([0xff,0,1,2,65]))
add('unknown.bin','application/octet-stream',Buffer.from([0,1,2,65,66]))
add('long.txt','text/plain',Buffer.from('Readable sentence. '.repeat(2200)))
add('utf16.txt','text/plain',Buffer.concat([Buffer.from([255,254]),Buffer.from('UTF16 invoice 4321','utf16le')]))
const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Actual inputs'),calc=book.addWorksheet('Calculations')
sheet.addRow(['Employee','Pay']);sheet.addRow(['Ada',1250]);sheet.addRow(['Lin',1500])
calc.addRow(['Metric','Value']);calc.addRow(['Total',{formula:"SUM('Actual inputs'!B2:B3)",result:2750}]);calc.addRow(['Uncalculated',{formula:'UNKNOWN(1)'}]);calc.addRow(['Rate',0.05]);calc.getCell('B4').numFmt='0%'
const xlsx=await book.xlsx.writeBuffer();add('payroll.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xlsx);add('second-sheet.xlsx','',xlsx,{start:2,end:2})
const deck=new pptxgen();let slide=deck.addSlide();slide.addText('First slide actual title',{x:1,y:1,w:7,h:1});slide.addNotes('Speaker note: actual launch date is October 20.')
slide=deck.addSlide();slide.addText('Second slide actual title',{x:1,y:1,w:7,h:1});slide.addTable([['Region','Count'],['North','42']],{x:1,y:2,w:7,h:1})
const pptx=await deck.write({outputType:'nodebuffer'});add('actual-deck.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',pptx);add('slide-two.pptx','',pptx,{start:2,end:2})
add('invalid-range.pptx','',pptx,{start:0,end:1})
const doc=new Document({sections:[{children:[new Paragraph('Actual document paragraph'),new Table({rows:[new TableRow({children:[new TableCell({children:[new Paragraph('Actual cell A')]}),new TableCell({children:[new Paragraph('Actual cell B')]})]})]})]}]})
add('actual.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',await Packer.toBuffer(doc))
let pdf=new jsPDF();pdf.text('Actual PDF invoice 12345',20,30);add('text.pdf','application/pdf',pdf.output('arraybuffer'))
pdf=new jsPDF();pdf.addPage();add('no-text.pdf','application/pdf',pdf.output('arraybuffer'))
pdf=new jsPDF();pdf.addImage(new Uint8Array(png),'PNG',20,20,60,40);add('image-only.pdf','application/pdf',pdf.output('arraybuffer'))
pdf=new jsPDF();pdf.text('Page one evidence',20,30);pdf.addPage();add('mixed.pdf','application/pdf',pdf.output('arraybuffer'))
pdf=new jsPDF();for(let i=1;i<=101;i++){if(i>1)pdf.addPage();pdf.text('Evidence on page '+i,20,30)}
const many=pdf.output('arraybuffer');add('many-pages.pdf','application/pdf',many);add('last-page.pdf','application/pdf',many,{start:101,end:101})
add('broken.pdf','application/pdf',Buffer.from('%PDF-1.7\nnot a valid pdf'))
const malformed=new JSZip();malformed.file('word/document.xml','<!DOCTYPE x [<!ENTITY a "hi">]><document>&a;</document>');add('entity.docx','',await malformed.generateAsync({type:'nodebuffer'}))
const huge=new JSZip();huge.file('xl/workbook.xml','x'.repeat(8*1024*1024+1000));const compressed=await huge.generateAsync({type:'nodebuffer',compression:'DEFLATE'});add('oversize.xlsx','',compressed)
// Forge the directory's declared size downward; actual streamed output must
// still stop at8MB before it can accumulate the expansion in memory.
const forged=Buffer.from(compressed);for(let i=0;i<forged.length-46;i++)if(forged.readUInt32LE(i)===0x02014b50&&forged.readUInt32LE(i+24)>8*1024*1024){forged.writeUInt32LE(1,i+24);break}
add('forged-size.xlsx','',forged)
const fixture=`import{extractAttachment,attachmentContext,attachmentExtractionSummary}from'/src/components/workspace/extractText.ts';window.readFixture=async(f)=>{const bytes=Uint8Array.from(atob(f.data),c=>c.charCodeAt(0));const result=await extractAttachment(new File([bytes],f.name,{type:f.type}),f.range||{});return{...result,dataUrl:result.dataUrl?'retained':undefined,context:attachmentContext(result),summary:attachmentExtractionSummary(result)}};window.fixtureReady=true;`
const server=await createServer({configFile:false,root,plugins:[react(),{name:'extraction-fixture',resolveId(id){if(id==='/@extraction')return'\0extraction'},load(id){if(id==='\0extraction')return fixture},configureServer(vite){vite.middlewares.use('/__extract',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__extract','<!doctype html><html><body><script type="module" src="/@extraction"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:0,hmr:false}})
let browser;const reports={},errors=[]
try{
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`
  browser=await chromium.launch();const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin||/^(data|blob):/.test(route.request().url())?route.continue():route.abort())
  await page.goto(origin+'/__extract');await page.waitForFunction(()=>window.fixtureReady)
  for(const f of fixtures){const r=await page.evaluate(f=>window.readFixture(f),f);reports[f.name]=r;console.log(`${f.name}: ${r.extraction.status} (${r.extraction.processed}/${r.extraction.total} ${r.extraction.unit})`, r.extraction.notes)}
  assert.match(reports['note.txt'].text,/paid invoice 12345/);assert.equal(reports['note.txt'].extraction.status,'complete')
  assert.equal(reports['actual-image.png'].extraction.status,'image');assert.equal(reports['actual-image.png'].dataUrl,'retained');assert.equal(reports['actual-image.png'].isImage,true)
  assert.equal(reports['broken-image.png'].extraction.status,'failed');assert.equal(reports['broken-image.png'].dataUrl,undefined)
  assert.equal(reports['binary.txt'].extraction.status,'failed');assert.equal(reports['binary.txt'].text,'')
  assert.equal(reports['unknown.bin'].extraction.status,'unsupported');assert.equal(reports['unknown.bin'].text,'');assert.match(reports['unknown.bin'].context,/content not read/)
  assert.equal(reports['long.txt'].extraction.status,'partial');assert.equal(reports['long.txt'].text.length,30000);assert.match(reports['long.txt'].context,/remainder has not been read/)
  assert.match(reports['utf16.txt'].text,/UTF16 invoice 4321/)
  assert.match(reports['payroll.xlsx'].text,/A2=Ada\tB2=1250/);assert.match(reports['payroll.xlsx'].text,/cached value: 2750; freshness unknown/);assert.match(reports['payroll.xlsx'].text,/UNKNOWN\(1\) \[no cached result\]/);assert.match(reports['payroll.xlsx'].text,/number format: 0%/)
  assert.equal(reports['payroll.xlsx'].extraction.processed,2);assert.equal(reports['payroll.xlsx'].extraction.status,'complete')
  assert.equal(reports['second-sheet.xlsx'].extraction.status,'partial');assert.equal(reports['second-sheet.xlsx'].extraction.processed,1);assert.ok(!reports['second-sheet.xlsx'].text.includes('A2=Ada'))
  assert.match(reports['actual-deck.pptx'].text,/First slide actual title/);assert.match(reports['actual-deck.pptx'].text,/Speaker note: actual launch date/);assert.match(reports['actual-deck.pptx'].text,/North/);assert.match(reports['actual-deck.pptx'].text,/42/)
  assert.equal(reports['slide-two.pptx'].extraction.status,'partial');assert.match(reports['slide-two.pptx'].text,/Second slide actual title/);assert.ok(!reports['slide-two.pptx'].text.includes('First slide actual title'))
  assert.equal(reports['invalid-range.pptx'].extraction.status,'failed');assert.match(reports['invalid-range.pptx'].context,/Invalid extraction range/)
  assert.match(reports['actual.docx'].text,/Actual document paragraph/);assert.match(reports['actual.docx'].text,/\[Table cell\] Actual cell A/)
  assert.match(reports['text.pdf'].text,/Actual PDF invoice 12345/);assert.equal(reports['text.pdf'].extraction.status,'complete')
  assert.equal(reports['no-text.pdf'].extraction.status,'needs-ocr');assert.match(reports['no-text.pdf'].context,/OCR/)
  assert.equal(reports['image-only.pdf'].extraction.status,'needs-ocr');assert.match(reports['image-only.pdf'].context,/image content has not been read/)
  assert.equal(reports['mixed.pdf'].extraction.status,'partial');assert.match(reports['mixed.pdf'].context,/Pages 2 have no selectable text/)
  assert.equal(reports['many-pages.pdf'].extraction.processed,100);assert.equal(reports['many-pages.pdf'].extraction.total,101);assert.equal(reports['many-pages.pdf'].extraction.status,'partial');assert.ok(!reports['many-pages.pdf'].text.includes('Evidence on page 101'))
  assert.match(reports['last-page.pdf'].text,/Evidence on page 101/);assert.equal(reports['last-page.pdf'].extraction.processed,1);assert.equal(reports['last-page.pdf'].extraction.status,'partial')
  for(const name of ['broken.pdf','entity.docx','oversize.xlsx','forged-size.xlsx'])assert.equal(reports[name].extraction.status,'failed',name)
  assert.match(reports['oversize.xlsx'].context,/8 MB/);assert.match(reports['forged-size.xlsx'].context,/decompression exceeded/)
  assert.deepEqual(errors,[])
  await writeFile(output+'/report.json',JSON.stringify({passed:true,fixtureCount:fixtures.length,errors,reports},null,2))
  console.log(`PASS ${fixtures.length} real browser attachment fixtures: actual Office/PDF parsers, range coverage, no-text/OCR-needed, binary rejection, decompression bounds and truthful model context.`)
}finally{await browser?.close();await server.close()}

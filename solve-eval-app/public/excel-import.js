(function(root){
 'use strict';
 const xlsx=typeof module!=='undefined'&&module.exports?require('./vendor/xlsx.full.min'):root.XLSX;
 const business=typeof module!=='undefined'&&module.exports?require('./business-import'):root.BusinessImport;
 const isExcel=name=>/\.(xlsx|xls)$/i.test(name);
 function open(bytes){
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(data.byteLength>25*1024*1024)throw Error('文件超过25MB，请拆分后导入');
  const zip=data[0]===0x50&&data[1]===0x4b,ole=data[0]===0xd0&&data[1]===0xcf;
  if(!zip&&!ole)throw Error('文件不是有效的Excel工作簿，请检查格式，不要只修改扩展名');
  let book;try{book=xlsx.read(data,{type:'array',sheetRows:2002,cellFormula:true,cellText:true,cellDates:false});}
  catch{throw Error('无法读取Excel文件，请检查是否加密、损坏或格式不受支持');}
  if(!book.SheetNames?.length)throw Error('Excel文件没有可读取的工作表');
  return book;
 }
 function readRows(book,sheetName){
  const name=sheetName||(book.SheetNames.length===1?book.SheetNames[0]:null);
  if(!name)throw Error('文件包含多个工作表，请先选择本次导入的工作表');
  const sheet=book.Sheets[name];if(!sheet)throw Error('所选工作表不存在');
  if(!sheet['!ref'])throw Error('所选工作表为空');
  const range=xlsx.utils.decode_range(sheet['!fullref']||sheet['!ref']);
  if(range.e.r-range.s.r>2001)throw Error('工作表超过2000条记录的读取范围，请拆分或清除多余空行后导入');
  if(range.e.c-range.s.c>=128)throw Error('工作表超过128列，请仅保留导入所需字段');
  if(sheet['!merges']?.length)throw Error('导入区域包含合并单元格，请取消合并，一条记录一行');
  for(const [key,cell]of Object.entries(sheet))if(!key.startsWith('!')){
   if(cell.f)throw Error('工作表包含公式，请先将公式转换为实际值后导入');
   if(cell.t==='e')throw Error('工作表包含错误单元格，请修正后导入');
  }
  const matrix=xlsx.utils.sheet_to_json(sheet,{header:1,raw:false,defval:'',blankrows:false});
  if(matrix.length<2)throw Error('所选工作表只有表头或为空，没有可导入记录');
  const headers=matrix.shift().map(x=>String(x).trim());
  if(headers.some(x=>!x))throw Error('Excel存在空白列名，请确保第一行为完整表头');
  if(new Set(headers).size!==headers.length)throw Error('Excel表头重复，请核对列名');
  const idLabels=new Set(['工单ID','会话ID','订单号','租户id','traceId','ticket_id','session_id','order_id','tenant_id','trace_id']);
  for(let c=0;c<headers.length;c++)if(idLabels.has(headers[c]))for(let r=range.s.r+1;r<=range.e.r;r++){
   const cell=sheet[xlsx.utils.encode_cell({r,c:c+range.s.c})];
   if(cell?.t==='n'&&!Number.isSafeInteger(cell.v))throw Error(headers[c]+'包含可能丢失精度的数字编号，请由来源系统按文本导出');
  }
  const rows=matrix.filter(row=>row.some(x=>String(x).trim())).map(row=>Object.fromEntries(headers.map((h,i)=>[h,String(row[i]??'')])));
  if(rows.length>2000)throw Error('每批最多2000条记录，请拆分导入');
  if(!rows.length)throw Error('所选工作表没有可导入记录');
  return rows;
 }
 function template(kind,profile){
  const schema=business.templateSchema(kind,profile);if(!schema)throw Error('请先选择一线或二线，再下载Excel模板');
  const sheet=xlsx.utils.aoa_to_sheet([schema.fields.map(([,label])=>label)]);
  sheet['!cols']=schema.fields.map(([key])=>({wch:/text|reply|conclusion|summary|opinion/.test(key)?52:24}));
  sheet['!rows']=[{hpt:28}];sheet['!autofilter']={ref:sheet['!ref']};
  const book=xlsx.utils.book_new();xlsx.utils.book_append_sheet(book,sheet,schema.name);
  return xlsx.write(book,{bookType:'xlsx',type:'array',compression:true});
 }
 const api={isExcel,open,readRows,template};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ExcelImport=api;
})(typeof globalThis!=='undefined'?globalThis:this);

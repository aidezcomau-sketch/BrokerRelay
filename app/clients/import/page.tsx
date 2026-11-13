'use client'

import {useEffect,useState} from 'react'
import Link from 'next/link'
import {supabase} from '@/lib/supabase'

type ClientRow = {first_name:string;last_name:string;email:string;mobile:string}
type ImportSummary = {received:number;created:number;duplicates:number;invalid:number;billing_events_created:number}
const required = ['first_name','last_name','email','mobile'] as const

// RFC4180-style quoted fields, commas and embedded newlines; rejects unclosed quotes.
function csvRows(text:string):string[][] {
  const rows:string[][] = [];let row:string[]=[];let field='';let quoted=false
  const source=text.replace(/^\uFEFF/,'')
  for (let i=0;i<source.length;i++) {
    const ch=source[i]
    if(ch==='"') {
      if(quoted&&source[i+1]==='"'){field+='"';i++}
      else if(quoted){quoted=false}
      else if(field===''){quoted=true}
      else throw Error('Invalid CSV quotation')
    } else if(ch===','&&!quoted){row.push(field);field=''}
    else if((ch==='\n'||ch==='\r')&&!quoted){
      if(ch==='\r'&&source[i+1]==='\n')i++
      row.push(field);if(row.some(v=>v.trim()))rows.push(row)
      row=[];field=''
    } else field+=ch
  }
  if(quoted)throw Error('Unclosed CSV quotation')
  row.push(field);if(row.some(v=>v.trim()))rows.push(row)
  return rows
}
function parse(text:string):ClientRow[] {
  const rows=csvRows(text)
  if(rows.length<2)throw Error('The file requires a header and at least one client')
  const header=rows[0].map(s=>s.trim().toLowerCase().replace(/\s+/g,'_'))
  const indexes=required.map(k=>header.indexOf(k))
  if(indexes.some(i=>i<0))throw Error('CSV headers must be: first_name,last_name,email,mobile')
  if(new Set(header).size!==header.length)throw Error('Duplicate CSV column header')
  if(rows.length-1>500)throw Error('Maximum 500 clients per upload')
  return rows.slice(1).map((r,i)=>{
    if(r.length!==header.length)throw Error(`Row ${i+2} has the wrong number of columns`)
    return Object.fromEntries(required.map((k,j)=>[k,r[indexes[j]].trim()])) as ClientRow
  })
}
export default function HistoricalImportPage(){
 const [organisationId,setOrganisationId]=useState('')
 const [clients,setClients]=useState<ClientRow[]>([])
 const [name,setName]=useState('')
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [result,setResult]=useState<ImportSummary|null>(null)
 async function load(file?:File){
   setError('');setResult(null);setClients([])
   if(!file)return
   if(file.size>250000) {setError('CSV is too large (maximum 250 KB)');return}
   try{setClients(parse(await file.text()));setName(file.name)}catch(e){setError(e instanceof Error?e.message:'Invalid CSV')}
 }
 async function upload(){
   setError('');setBusy(true)
   try{
     const {data:user}=await supabase.auth.getUser()
     if(!user.user)throw Error('Sign in to BrokerDesk first')
     // Identify the organisation from the broker's active profile; never accept a typed tenant ID.
     const {data:profiles,error:lookupError}=await supabase.from('broker_profiles')
       .select('organisation_id').eq('user_id',user.user.id).eq('is_active',true)
     if(lookupError)throw lookupError
     if(!profiles?.length)throw Error('Active broker profile required')
     if(profiles.length>1&&!organisationId)throw Error('Choose the correct company in the selector')
     const target=organisationId||profiles[0].organisation_id
     if(!profiles.some(p=>p.organisation_id===target))throw Error('Company selection is not authorised')
     const {data,error:rpcError}=await supabase.rpc('import_historical_clients',{
       p_organisation_id:target,p_rows:clients
     })
     if(rpcError)throw rpcError
     setResult(data as ImportSummary);setClients([])
   }catch(e){setError(e instanceof Error?e.message:'Import failed')}
   finally{setBusy(false)}
 }
 // Load company list on entry, including users with access to multiple brokerages.
 const [companies,setCompanies]=useState<{organisation_id:string}[]>([])
 const [loaded,setLoaded]=useState(false)
 async function getCompanies(){
   if(loaded)return;setLoaded(true)
   const {data:user}=await supabase.auth.getUser()
   if(!user.user)return
   const {data}=await supabase.from('broker_profiles').select('organisation_id')
     .eq('user_id',user.user.id).eq('is_active',true)
   setCompanies(data||[])
   if(data?.length===1)setOrganisationId(data[0].organisation_id)
 }
 useEffect(()=>{void getCompanies()},[])
 return <main className="container" style={{maxWidth:850,margin:'2rem auto',padding:'1rem'}}>
  <p><Link href="/clients">← Back to clients</Link></p>
  <section className="card">
   <h1>Import existing clients</h1>
   <p>For historical clients without application details. This import creates client records and broker assignments only; it does not create loans or settlement billing events.</p>
   <p>Required CSV columns: <code>first_name,last_name,email,mobile</code>. Maximum 500 rows per file.</p>
   <button type="button" className="secondary" onClick={()=>void getCompanies()}>Load my companies</button>
   {companies.length>1&&<label>Company <select value={organisationId} onChange={e=>setOrganisationId(e.target.value)}><option value="">Select company</option>{companies.map(c=><option key={c.organisation_id} value={c.organisation_id}>{c.organisation_id}</option>)}</select></label>}
   <label>Choose CSV<input type="file" accept=".csv,text/csv" onChange={e=>void load(e.target.files?.[0])}/></label>
   {clients.length>0&&<><h2>Review {clients.length} clients from {name}</h2>
     <div className="tableWrap"><table><thead><tr>{required.map(h=><th key={h}>{h.replace('_',' ')}</th>)}</tr></thead><tbody>{clients.slice(0,10).map((c,i)=><tr key={i}><td>{c.first_name}</td><td>{c.last_name}</td><td>{c.email}</td><td>{c.mobile}</td></tr>)}</tbody></table></div>
     {clients.length>10&&<p>Showing first 10 of {clients.length} rows.</p>}
     <button disabled={busy||!organisationId} onClick={()=>void upload()}>{busy?'Importing…':`Import ${clients.length} historical clients`}</button>
   </>}
   {error&&<p role="alert" className="notice error">{error}</p>}
   {result&&<p role="status" className="notice">Import complete: {result.created} created; {result.duplicates} existing/duplicate; {result.invalid} invalid; {result.billing_events_created} billing events.</p>}
  </section>
 </main>
}

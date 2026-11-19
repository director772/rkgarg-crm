// City / likha hua jagah ka naam → State. Sirf naam se milaan (koi bahar ka API nahi).
// Jo match na ho wo "Pata nahi" me jata hai, taki galat state na dikhe.
const S = {
  'Delhi': 'delhi,new delhi,ndls,dilli,delhi ncr,ncr,gandhi nagar delhi,karol bagh,chandni chowk,shahdara,rohini,dwarka,narela,najafgarh,mundka,uttam nagar,laxmi nagar,seelampur,okhla,saket,janakpuri,pitampura,mayur vihar,tilak nagar,paharganj,sadar bazar,kirti nagar,nangloi,burari,mustafabad,jafrabad,shastri nagar,krishna nagar,patel nagar,rajouri garden,vikaspuri,badarpur,sangam vihar',
  'Uttar Pradesh': 'uttar pradesh,up,u p,u.p,lucknow,kanpur,agra,meerut,varanasi,banaras,prayagraj,allahabad,ghaziabad,noida,greater noida,bareilly,aligarh,moradabad,saharanpur,gorakhpur,firozabad,jhansi,muzaffarnagar,mathura,vrindavan,ayodhya,faizabad,rampur,shahjahanpur,farrukhabad,mau,hapur,etawah,mirzapur,bulandshahr,sambhal,amroha,hardoi,fatehpur,raebareli,rae bareli,orai,sitapur,bahraich,modinagar,unnao,jaunpur,lakhimpur,hathras,banda,pilibhit,barabanki,khurja,gonda,mainpuri,lalitpur,etah,deoria,badaun,budaun,ghazipur,sultanpur,azamgarh,bijnor,basti,chandausi,akbarpur,ballia,tanda,shamli,baraut,kasganj,gola,khatauli,loni,sikandrabad,nagina,najibabad,kairana,deoband,chandpur,kannauj,auraiya,lakhimpur kheri,kheri,pratapgarh,siddharthnagar,maharajganj,kushinagar,padrauna,bhadohi,chitrakoot,mahoba,hamirpur up,jalaun,kaushambi,ambedkar nagar,shravasti,balrampur,sonbhadra,robertsganj,chandauli,amethi,bagpat,baghpat',
  'Haryana': 'haryana,hr,gurgaon,gurugram,faridabad,panipat,ambala,yamunanagar,yamuna nagar,rohtak,hisar,hissar,karnal,sonipat,sonepat,panchkula,bhiwani,sirsa,bahadurgarh,jind,thanesar,kurukshetra,kaithal,rewari,palwal,narnaul,fatehabad,gohana,tohana,mahendragarh,charkhi dadri,hansi,nuh,mewat,jhajjar,kosli',
  'Punjab': 'punjab,pb,ludhiana,amritsar,jalandhar,jullundur,patiala,bathinda,bhatinda,hoshiarpur,mohali,sas nagar,batala,pathankot,moga,abohar,malerkotla,khanna,phagwara,muktsar,barnala,rajpura,firozpur,ferozepur,kapurthala,zirakpur,kot kapura,faridkot,sangrur,fazilka,gurdaspur,mansa,nawanshahr,rupnagar,ropar,tarn taran',
  'Chandigarh': 'chandigarh',
  'Rajasthan': 'rajasthan,rj,jaipur,jodhpur,kota,bikaner,ajmer,udaipur,bhilwara,alwar,bharatpur,sikar,pali,sri ganganagar,ganganagar,kishangarh,beawar,hanumangarh,dhaulpur,dholpur,tonk,gangapur,sawai madhopur,churu,jhunjhunu,baran,chittorgarh,chittaurgarh,nagaur,makrana,sujangarh,barmer,jaisalmer,banswara,bundi,dausa,karauli,jalore,sirohi,abu road,mount abu,pratapgarh rj,rajsamand,nathdwara,dungarpur,hindaun,phalodi,balotra,bhiwadi,neemrana,ladnun,fatehpur shekhawati',
  'Madhya Pradesh': 'madhya pradesh,mp,m p,m.p,indore,bhopal,jabalpur,gwalior,ujjain,sagar,dewas,satna,ratlam,rewa,murwara,katni,singrauli,burhanpur,khandwa,bhind,chhindwara,guna,shivpuri,vidisha,chhatarpur,damoh,mandsaur,khargone,neemuch,pithampur,hoshangabad,narmadapuram,itarsi,sehore,betul,seoni,datia,nagda,dhar,morena,tikamgarh,shahdol,mandla,balaghat,ashoknagar,rajgarh,shajapur,sheopur,sidhi,umaria,anuppur,jhabua,alirajpur,barwani,harda,raisen,niwari,agar malwa,dindori',
  'Gujarat': 'gujarat,gj,ahmedabad,amdavad,surat,vadodara,baroda,rajkot,bhavnagar,jamnagar,junagadh,gandhinagar,gandhidham,anand,navsari,morbi,nadiad,surendranagar,bharuch,mehsana,bhuj,porbandar,palanpur,valsad,vapi,gondal,veraval,godhra,patan,kalol,dahod,botad,amreli,deesa,jetpur,kutch,kachchh,ankleshwar,himmatnagar,modasa,wadhwan,dwarka gujarat,somnath,silvassa',
  'Maharashtra': 'maharashtra,mh,mumbai,bombay,pune,poona,nagpur,thane,nashik,nasik,aurangabad,chhatrapati sambhajinagar,solapur,bhiwandi,amravati,navi mumbai,kolhapur,akola,ulhasnagar,sangli,malegaon,jalgaon,latur,dhule,ahmednagar,ahilyanagar,chandrapur,parbhani,ichalkaranji,jalna,ambarnath,bhusawal,panvel,badlapur,beed,gondia,satara,barshi,yavatmal,achalpur,osmanabad,dharashiv,nandurbar,wardha,udgir,hinganghat,kalyan,dombivli,vasai,virar,mira road,bhayandar,nanded,ratnagiri,sindhudurg,buldhana,washim,hingoli,gadchiroli,bhandara,palghar,karad,baramati,shirdi,pandharpur',
  'Bihar': 'bihar,br,patna,gaya,bhagalpur,muzaffarpur,darbhanga,purnia,purnea,arrah,ara,begusarai,katihar,munger,chhapra,saran,danapur,saharsa,sasaram,hajipur,dehri,siwan,motihari,nawada,bagaha,buxar,kishanganj,sitamarhi,jamalpur,jehanabad,aurangabad bihar,bettiah,madhubani,samastipur,gopalganj,supaul,araria,madhepura,khagaria,lakhisarai,sheikhpura,nalanda,bihar sharif,biharsharif,rohtas,kaimur,bhabua,vaishali,banka,jamui,arwal,sheohar',
  'Jharkhand': 'jharkhand,jh,ranchi,jamshedpur,tatanagar,dhanbad,bokaro,deoghar,phusro,hazaribagh,hazaribag,giridih,ramgarh,medininagar,daltonganj,chirkunda,dumka,godda,sahibganj,pakur,chaibasa,gumla,lohardaga,simdega,koderma,chatra,latehar,garhwa,jamtara,khunti,seraikela',
  'West Bengal': 'west bengal,wb,bengal,kolkata,calcutta,howrah,durgapur,asansol,siliguri,bardhaman,burdwan,malda,english bazar,baharampur,berhampore,habra,kharagpur,shantipur,dankuni,dhulian,ranaghat,haldia,raiganj,krishnanagar,nabadwip,medinipur,midnapore,jalpaiguri,balurghat,basirhat,bankura,chakdaha,darjeeling,alipurduar,purulia,jangipur,bolpur,bangaon,cooch behar,coochbehar,barasat,barrackpore,serampore,hooghly,bally,kalyani',
  'Odisha': 'odisha,orissa,odisa,bhubaneswar,cuttack,rourkela,brahmapur,berhampur,sambalpur,puri,balasore,baleshwar,bhadrak,baripada,balangir,bolangir,jharsuguda,jeypore,bargarh,rayagada,kendujhar,keonjhar,angul,dhenkanal,paradip,jajpur,koraput,kendrapara,jagatsinghpur,nabarangpur,sundargarh,kalahandi,bhawanipatna,ganjam,nuapada,boudh,sonepur,malkangiri,gajapati,nayagarh,khordha,khurda',
  'Chhattisgarh': 'chhattisgarh,chattisgarh,cg,raipur,bhilai,bilaspur,korba,durg,rajnandgaon,raigarh,jagdalpur,ambikapur,dhamtari,mahasamund,chirmiri,kanker,janjgir,champa,kawardha,kabirdham,bemetara,balod,mungeli,surajpur,balrampur cg,jashpur,kondagaon,dantewada,bijapur cg,sukma,narayanpur,gariaband,baloda bazar',
  'Uttarakhand': 'uttarakhand,uttaranchal,dehradun,haridwar,roorkee,haldwani,rudrapur,kashipur,rishikesh,nainital,almora,pithoragarh,kotdwar,ramnagar,kichha,sitarganj,jaspur,mussoorie,tehri,srinagar garhwal,chamoli,bageshwar,champawat,uttarkashi,pauri,khatima,vikasnagar',
  'Himachal Pradesh': 'himachal pradesh,himachal,hp,shimla,mandi,solan,dharamshala,dharamsala,baddi,nahan,paonta sahib,sundernagar,chamba,una,kullu,manali,hamirpur hp,bilaspur hp,kangra,palampur,nalagarh,parwanoo,kinnaur,lahaul,spiti',
  'Jammu & Kashmir': 'jammu,kashmir,jammu and kashmir,j&k,jk,j k,srinagar,anantnag,baramulla,sopore,kathua,udhampur,rajouri,poonch,doda,kishtwar,pulwama,shopian,kupwara,budgam,ganderbal,bandipora,reasi,ramban,samba,kulgam',
  'Ladakh': 'ladakh,leh,kargil',
  'Assam': 'assam,guwahati,gauhati,silchar,dibrugarh,jorhat,nagaon,tinsukia,tezpur,bongaigaon,dhubri,diphu,north lakhimpur,karimganj,sivasagar,goalpara,barpeta,lumding,mangaldoi,golaghat,hailakandi,nalbari,kokrajhar,dhemaji,morigaon,udalguri,hojai',
  'Meghalaya': 'meghalaya,shillong,tura,jowai',
  'Tripura': 'tripura,agartala,udaipur tripura,dharmanagar,kailashahar',
  'Manipur': 'manipur,imphal,thoubal,churachandpur',
  'Mizoram': 'mizoram,aizawl,lunglei',
  'Nagaland': 'nagaland,kohima,dimapur,mokokchung',
  'Arunachal Pradesh': 'arunachal pradesh,arunachal,itanagar,naharlagun,pasighat,tawang',
  'Sikkim': 'sikkim,gangtok,namchi',
  'Karnataka': 'karnataka,bangalore,bengaluru,mysore,mysuru,hubli,dharwad,hubballi,mangalore,mangaluru,belgaum,belagavi,gulbarga,kalaburagi,davanagere,davangere,bellary,ballari,vijayapura,bijapur,shimoga,shivamogga,tumkur,tumakuru,raichur,bidar,hospet,hosapete,gadag,udupi,robertsonpet,kolar,mandya,chikmagalur,chikkamagaluru,hassan,chitradurga,bagalkot,karwar,haveri,koppal,ramanagara,chamarajanagar,yadgir,madikeri,kodagu',
  'Tamil Nadu': 'tamil nadu,tamilnadu,tn,chennai,madras,coimbatore,madurai,tiruchirappalli,trichy,salem,tirunelveli,tiruppur,tirupur,vellore,erode,thoothukudi,tuticorin,dindigul,thanjavur,ranipet,sivakasi,karur,udhagamandalam,ooty,hosur,nagercoil,kanchipuram,kumbakonam,cuddalore,rajapalayam,pudukkottai,ambur,tiruvannamalai,pollachi,namakkal,krishnagiri,dharmapuri,villupuram,viluppuram,nagapattinam,ramanathapuram,virudhunagar,theni,sivaganga,perambalur,ariyalur,tiruvarur,karaikudi',
  'Kerala': 'kerala,kl,thiruvananthapuram,trivandrum,kochi,cochin,ernakulam,kozhikode,calicut,thrissur,trichur,kollam,quilon,palakkad,palghat,alappuzha,alleppey,malappuram,kannur,cannanore,kottayam,kasaragod,pathanamthitta,idukki,wayanad,manjeri,tirur,thalassery,ponnani,vatakara,kanhangad,payyanur,koyilandy,perinthalmanna,changanassery,kayamkulam,neyyattinkara',
  'Andhra Pradesh': 'andhra pradesh,andhra,ap,a p,visakhapatnam,vizag,vijayawada,guntur,nellore,kurnool,rajahmundry,rajamahendravaram,kakinada,tirupati,kadapa,cuddapah,anantapur,anantapuramu,vizianagaram,eluru,ongole,nandyal,machilipatnam,adoni,tenali,chittoor,hindupur,proddatur,bhimavaram,madanapalle,guntakal,dharmavaram,gudivada,srikakulam,narasaraopet,tadipatri,kavali,amaravati',
  'Telangana': 'telangana,ts,hyderabad,secunderabad,warangal,nizamabad,karimnagar,khammam,ramagundam,mahbubnagar,mahabubnagar,nalgonda,adilabad,suryapet,miryalaguda,siddipet,jagtial,mancherial,kothagudem,bodhan,sangareddy,medak,kamareddy,vikarabad,wanaparthy,nirmal,gadwal,jangaon,bhongir,sircilla',
  'Goa': 'goa,panaji,panjim,margao,madgaon,vasco,vasco da gama,mapusa,ponda',
  'Puducherry': 'puducherry,pondicherry,pondy,karaikal,yanam,mahe',
  'Andaman & Nicobar': 'andaman,nicobar,port blair',
  'Lakshadweep': 'lakshadweep,kavaratti',
  'Dadra & Nagar Haveli and Daman & Diu': 'dadra,nagar haveli,daman,diu',
  'Nepal': 'nepal,kathmandu,birgunj,biratnagar,pokhara,nepalganj,butwal,bhairahawa,janakpur',
  'Bhutan': 'bhutan,thimphu,phuntsholing',
  'Bangladesh': 'bangladesh,dhaka'
};
const norm = t => ' ' + String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
const PHRASES = [];
for (const [state, list] of Object.entries(S)) for (const a of list.split(',')) { const k = norm(a); if (k.trim()) PHRASES.push([k, state]); }
PHRASES.sort((x, y) => y[0].length - x[0].length); // lambe naam pehle ("new delhi" > "delhi", "aurangabad bihar" > "aurangabad")
const cache = new Map();
/** City ka likha hua naam → State, ya '' agar pakka pata nahi. */
export function stateOf(city) {
  const key = norm(city); if (!key.trim()) return '';
  if (cache.has(key)) return cache.get(key);
  let st = '';
  for (const [p, s] of PHRASES) if (key.includes(p)) { st = s; break; }
  if (cache.size < 5000) cache.set(key, st);
  return st;
}

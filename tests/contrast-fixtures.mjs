export const noLookup = () => ({canon:'',canonQuery:'',canonEvidence:[],wikiQuery:'',wikiOutcome:'unreviewed',wikiNote:'',canonConflict:''});
export const clause = (recordId,quote,text=quote,state='established') => ({text,state,evidence:[{recordId,quote}]});
export const majorFields = (key='city-access') => ({importance:'major',changeState:'established',divergencePolicyVersion:1,divergenceKey:key,
    changedPremise:'原作中封锁导致车队无法入城；当前取得唯一钥匙，已经改变进城条件。',canonQuery:'车队是否能进城',
    canon:'原作中城门封锁，车队没有钥匙而无法入城。',canonPolicyVersion:3,canonStatus:'provided_supported',canonSourceIds:['book'],
    canonEvidence:[{sourceId:'book',kind:'novel',title:'虚构测试资料',quote:'原作中城门封锁，车队没有钥匙而无法入城。'}]});
export const group = (current,extra={}) => ({title:'钥匙与进城安排改变',current,canonRecordIds:[...new Set(current.flatMap(c=>c.evidence.map(e=>e.recordId)))],lookup:noLookup(),changedPremises:'',...extra});
export const record = (id,quote=`记录${id}的原句。`,extra={}) => ({id,title:'城门通路改变',...majorFields(),evidence:[{messageId:2,quote}],entities:['旅人'],parentIds:[],fact:'摘要错误：城门已关闭',constraint:'虚构的安排',...extra});

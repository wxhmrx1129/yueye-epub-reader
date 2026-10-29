import type { Preferences, ThemeId } from './types';

export const DEFAULT_PREFERENCES: Preferences = {
  id: 'global', theme: 'sage', customBackground: '#e5eddb', customText: 'auto',
  fontSize: 22, contentWidth: 1000, fontFamily: 'serif', lineHeight: 1.8,
  readingMode: 'paginated', sidebarOpen: true,
};
export const THEMES: {id: ThemeId; name: string; background: string; text: string; surface: string; muted: string; border: string}[] = [
  {id:'paper', name:'素白', background:'#fafaf8', text:'#30372f',surface:'#ffffff',muted:'#757e73',border:'#e5e8e0'},
  {id:'sand', name:'暖砂', background:'#f4ecda', text:'#494232',surface:'#faf5e9',muted:'#8b806d',border:'#e2d9c8'},
  {id:'sage', name:'青苔', background:'#e5eddb', text:'#344535',surface:'#f0f4e9',muted:'#778670',border:'#d3dec9'},
  {id:'graphite', name:'暮灰', background:'#363c3b', text:'#e1e5dc',surface:'#2d3332',muted:'#a7b2a3',border:'#4b5450'},
  {id:'night', name:'深夜', background:'#202724', text:'#d2dacd',surface:'#19211d',muted:'#94a38e',border:'#38453b'},
];
export function themeFor(p: Preferences) {
  if(p.theme !== 'custom') return THEMES.find(t=>t.id===p.theme) ?? THEMES[2];
  const text = p.customText === 'auto' ? autoText(p.customBackground) : p.customText;
  return {id:'custom' as const,name:'自定义',background:p.customBackground,text,surface:p.customBackground,muted:text,border: text+'30'};
}
function luminance(hex: string) {
  const parts = [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722;
}
export function contrast(a:string,b:string) { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
export function autoText(background:string) { return contrast(background,'#222a22')>=contrast(background,'#f5f6f0')?'#222a22':'#f5f6f0'; }
export function normalizePreferences(value: Partial<Preferences>): Preferences {
  const p={...DEFAULT_PREFERENCES,...value,id:'global' as const};
  p.fontSize=Math.min(40,Math.max(14,Number(p.fontSize)||22));
  p.contentWidth=Math.min(1400,Math.max(480,Number(p.contentWidth)||1000));
  p.lineHeight=[1.4,1.6,1.8,2,2.2].includes(p.lineHeight)?p.lineHeight:1.8;
  if(![...THEMES.map(t=>t.id),'custom'].includes(p.theme))p.theme='sage';
  if(!['serif','sans','original'].includes(p.fontFamily))p.fontFamily='serif';
  if(!['paginated','scrolled'].includes(p.readingMode))p.readingMode='paginated';
  if(!/^#[0-9a-f]{6}$/i.test(p.customBackground))p.customBackground=DEFAULT_PREFERENCES.customBackground;
  if(p.customText!=='auto'&&!/^#[0-9a-f]{6}$/i.test(p.customText))p.customText='auto';
  return p;
}

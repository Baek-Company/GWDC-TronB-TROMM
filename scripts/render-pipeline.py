"""Render the documented TROMM application pipeline as PNG and editable SVG."""
from pathlib import Path
from html import escape
from PIL import Image, ImageDraw, ImageFont
import math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'images'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 2400, 1810
im = Image.new('RGB', (W, H), '#f5f7fb')
d = ImageDraw.Draw(im)
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', '<rect width="100%" height="100%" fill="#f5f7fb"/>']
INK, MUTED, BLUE, TEAL = '#14243a', '#53657a', '#315ed5', '#087f79'

def box(x, y, w, h, fill='white', stroke='#dce3ed', radius=20):
    d.rounded_rectangle((x,y,x+w,y+h), radius, fill, stroke, 2)
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')

def txt(x,y,s,size=27,color=INK,bold=False):
    font=ImageFont.truetype('C:/Windows/Fonts/malgunbd.ttf' if bold else 'C:/Windows/Fonts/malgun.ttf',size)
    d.text((x,y),s,font=font,fill=color,anchor='lt')
    svg.append(f'<text x="{x}" y="{y}" font-family="Malgun Gothic, Noto Sans KR, sans-serif" font-size="{size}" font-weight="{700 if bold else 400}" fill="{color}" dominant-baseline="text-before-edge">{escape(s)}</text>')

def arrow(points,color='#8596ad',width=4):
    d.line(points,fill=color,width=width,joint='curve')
    x,y=points[-1]; a,b=points[-2]; angle=math.atan2(y-b,x-a)
    tip=[(x,y),(x-15*math.cos(angle-.45),y-15*math.sin(angle-.45)),(x-15*math.cos(angle+.45),y-15*math.sin(angle+.45))]
    d.polygon(tip,fill=color)
    svg.append(f'<polyline points="{" ".join(f"{a},{b}" for a,b in points)}" fill="none" stroke="{color}" stroke-width="{width}"/>')
    svg.append(f'<polygon points="{" ".join(f"{a},{b}" for a,b in tip)}" fill="{color}"/>')

def card(x,y,w,h,k,title,lines,color=BLUE):
    box(x,y,w,h)
    txt(x+24,y+21,k,22,color,True)
    txt(x+24,y+58,title,30,INK,True)
    for i,line in enumerate(lines): txt(x+24,y+111+39*i,line,23,MUTED)

txt(80,50,'TROMM',29,BLUE,True)
txt(80,101,'TRON Asset Planning Pipeline',57,INK,True)
txt(82,184,'GWDC 2026 Challenge B  |  Requirements → Planning → Approved Transactions → Verification',28,MUTED)
box(1920,60,400,63,'#e6ecfc','#e6ecfc',30)
txt(1945,77,'Implementation · 2026.09.30',23,BLUE,True)

xs=[80,650,1220,1790]
card(xs[0],270,530,255,'01  INPUT','User Requirements',['Holdings · horizon · dated expenses','Reserves · risk preferences · questions','React / Vite UI · chat and forms'])
card(xs[1],270,530,255,'02  UNDERSTAND','Extract & Confirm',['NIM gpt-oss-20b / template fallback','Explicit facts → validated JSON','Ask for missing facts · reconfirm edits'])
card(xs[2],270,530,255,'03  EVIDENCE','Research & Read',['JustLend REST · TRON RPC','Rates · liquidity · balances · fee evidence','Track source, chain and query time'])
card(xs[3],270,530,255,'04  PLAN','Calculate & Assess',['Protect expenses and reserves first','Dated allocation · cost and risk checks','Compare · select · save a baseline'])
for i in range(3): arrow([(xs[i]+530,395),(xs[i+1]-6,395)],BLUE)

# The selected chain determines the route; Mainnet never flows into Nile execution.
arrow([(2055,525),(2055,565),(1200,565),(1200,578)],BLUE)
txt(800,588,'Route by chain · keep assets and evidence separate',24,MUTED)
arrow([(1200,630),(635,630),(635,664)],BLUE)
arrow([(1200,630),(1785,630),(1785,664)],TEAL)

box(80,680,1090,295,'#edf2ff','#cbd8fb')
txt(110,708,'A  MAINNET',24,BLUE,True)
txt(110,752,'Read-only Data & Scenario Planning',36,INK,True)
txt(110,813,'USDT scenarios assume a synthetic 5% annual APY',28,MUTED)
txt(110,859,'Live market reads are separate from hypothetical yield',27,MUTED)
txt(110,911,'Mainnet execution unsupported · execution eligibility: false',26,BLUE,True)

box(1230,680,1090,295,'#eaf7f4','#bfe2da')
txt(1260,708,'B  NILE TESTNET',24,TEAL,True)
txt(1260,752,'User-approved Technical Testing',36,INK,True)
txt(1260,813,'TRX ↔ jTRX: live test deposits and redemptions verified',28,MUTED)
txt(1260,859,'PSM USDD ↔ USDT: separate experiment; live trades unverified',27,MUTED)
txt(1260,911,'Each transaction needs preview confirmation and wallet signing',26,TEAL,True)
arrow([(1785,975),(1785,1015),(296,1015),(296,1055)],TEAL)

execs=[
 ('05  PREVIEW','Preview',['Contract · balances · fees','Check expense protection']),
 ('06  AUTHORIZE','Authorize & Reserve',['TronLink ownership message','Revalidate, then reserve']),
 ('07  SIGN','Sign Transaction',['Individual TronLink signature','Check signed payload / txID']),
 ('08  BROADCAST','Accept & Broadcast',['Accept into encrypted SQLite','Then broadcast from browser']),
 ('09  VERIFY','Verify On-chain',['Read solidified receipt','Match position / received funds'])]
for i,(k,t,ls) in enumerate(execs):
    x=80+i*455
    card(x,1070,420,220,k,t,ls,TEAL)
    if i<4: arrow([(x+420,1178),(x+449,1178)],TEAL)

arrow([(2110,1290),(2110,1340),(1790,1340),(1790,1370)],TEAL)
arrow([(98,975),(55,975),(55,1470),(80,1470)],BLUE)
box(80,1385,2240,250)
txt(112,1415,'10  MONITOR & REVIEW',23,BLUE,True)
txt(112,1460,'Monitor Plans & Review Records',35,INK,True)
txt(112,1522,'Recheck on open / every 5 min / tab focus',26,MUTED)
txt(112,1565,'Maintain · pause new deposits · review',26,MUTED)
txt(960,1460,'Store & Recover',31,INK,True)
txt(960,1522,'localStorage: inputs, plans, records',26,MUTED)
txt(960,1565,'SQLite: approvals, pending txIDs',26,MUTED)
txt(1690,1460,'Export & Replay',31,INK,True)
txt(1690,1522,'Session JSON · snapshot / synthetic',25,MUTED)
txt(1690,1565,'Replay / adjustment drafts do not trade',23,MUTED)
arrow([(2320,1480),(2360,1480),(2360,243),(2060,243),(2060,264)],BLUE)
txt(1300,1690,'Reassess → confirm updated plan → approve each new transaction',24,BLUE,True)
txt(80,1700,'Monitoring while app is open · no unattended trading',23,MUTED)
txt(80,1750,'STACK   React + TypeScript  /  Node API  /  NIM  /  REST·RPC  /  TronLink  /  Encrypted SQLite',23,MUTED)
svg.append('</svg>')
im.save(OUT / 'tromm-pipeline.png',optimize=True)
(OUT / 'tromm-pipeline.svg').write_text('\n'.join(svg),encoding='utf-8')
print(OUT / 'tromm-pipeline.png')

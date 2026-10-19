"""Draw the Steady Days app icon: a round tree on forest green."""
from PIL import Image, ImageDraw
BG=(47,90,68);LEAF=(220,232,222);LEAF2=(196,216,200);TRUNK=(147,101,43)
def icon(size,scale):
    S=size*4;im=Image.new("RGB",(S,S),BG);d=ImageDraw.Draw(im)
    c=S/2;r=S*0.20*scale
    d.rounded_rectangle([c-r*0.16,c+r*0.35,c+r*0.16,c+r*1.75],radius=r*0.1,fill=TRUNK)
    for dx,dy,k,col in [(-0.55,0.15,0.75,LEAF2),(0.55,0.15,0.75,LEAF2),(0,-0.35,0.95,LEAF),(-0.35,0.35,0.7,LEAF),(0.35,0.35,0.7,LEAF)]:
        x,y,rr=c+dx*r,c+dy*r-r*0.25,r*k;d.ellipse([x-rr,y-rr,x+rr,y+rr],fill=col)
    return im.resize((size,size),Image.LANCZOS)
icon(192,1.0).save("icons/icon-192.png");icon(512,1.0).save("icons/icon-512.png")
icon(512,0.8).save("icons/icon-maskable-512.png");icon(180,1.0).save("icons/apple-touch-icon.png")
print("icons ok")

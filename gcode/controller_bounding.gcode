
;Generated with Cura_SteamEngine 5.4.0
T1; right extruder
M82 ;absolute extrusion mode
;SV04 start
M140 S110; print bed temperature, heat while continue to conduct following code
M104 S260; nozzle temperature, heat while continue to conduct following code
M280 P0 S160;
G4 P100; pause 100ms
G28; home x, y, z
M420 S1; bed leveling
M190 S110; print bed temperature, wait until reach the temp
M109 S260; nozzle temperature, wait until reach the temp
G92 E0; reset extrusion count to 0; G92=set position, E=extrude, 0=set to zero

; test print of two segments of lines
G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
G92 E0 ;Reset Extruder
G1 Z2.0 F3000;
G92 E0
G92 E0
G1 F2400 E-0.5

M106 S255; start fan
M204 S500; set acceleration
M205 X16 Y16; set acceleration
            

G0 F2880 X130.8 Y108.29999856948852 Z0.2; move to start point
M205 X8 Y8; tune down acceleration
G1 F2400 E0; not sure the purpose of this line
G1 X130.8000 Y193.7000 Z0.2000 E5.9780 F800
G1 X171.2000 Y193.7000 Z0.2000 E8.8060 F800
G1 X171.2000 Y108.3000 Z0.2000 E14.7840 F800
G1 X130.8000 Y108.3000 Z0.2000 E17.6120 F800
G92 E0


;SV04 end
M107; turn off fan
G91 ;Relative positioning
G1 E-2 F2700 ;Retract a bit
G1 E-2 Z0.2 F2400 ;Retract and raise Z
G1 X0 Y240 F3000 ;Wipe out
G1 Z10 ;Raise Z more
G90 ;Absolute positionning
G1 X0 Y302 ;Present print
M106 S0 ;Turn-off fan
M104 S0 ;Turn-off hotend
M140 S0 ;Turn-off bed
M84 X Y E ;Disable all steppers but Z
M82 ;absolute extrusion mode
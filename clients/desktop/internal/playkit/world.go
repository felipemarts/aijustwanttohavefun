package playkit

import (
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// World is what the character has seen of the map: for each room its exits (in the order the game listed them),
// and the room where each NPC and each monster kind was last seen.
type World struct {
	Rooms    map[string][][2]string `json:"rooms,omitempty"`
	NPCs     map[string]string      `json:"npcs,omitempty"`
	Monsters map[string]string      `json:"monsters,omitempty"`
	// Danger (v2): the highest monster level seen in each room (by visiting it or probing it).
	Danger map[string]int `json:"danger,omitempty"`
}

// Observe records an observation's room (README, "Memory"): its exits replace what was known of it (a new room is
// added only while fewer than worldRooms are known), and every NPC and monster listed there is placed in it.
func (k *Kit) Observe(w *World, obs jv.Value) {
	room := jvRoom(obs)
	id := str(room, "id")
	if id == "" {
		return
	}
	if w.Rooms == nil {
		w.Rooms = map[string][][2]string{}
	}
	if w.NPCs == nil {
		w.NPCs = map[string]string{}
	}
	if w.Monsters == nil {
		w.Monsters = map[string]string{}
	}
	if w.Danger == nil {
		w.Danger = map[string]int{}
	}
	if _, ok := w.Danger[id]; !ok {
		w.Danger[id] = 0
	}
	if _, known := w.Rooms[id]; known || len(w.Rooms) < k.Lim("worldRooms") {
		exits, _ := room.Get("exits")
		pairs := make([][2]string, 0, len(exits.O))
		for _, m := range exits.O {
			pairs = append(pairs, [2]string{m.Key, m.Val.Text()})
		}
		w.Rooms[id] = pairs
	}
	for _, key := range []string{"npcs", "monsters"} {
		list, _ := room.Get(key)
		for _, x := range list.A {
			if n := str(x, "id"); n != "" {
				if key == "npcs" {
					w.NPCs[n] = id
				} else {
					w.Monsters[n] = id
					if l, _ := x.Get("lvl"); int(l.N) > w.Danger[id] {
						w.Danger[id] = int(l.N)
					}
				}
			}
		}
	}
}

// ObserveProbe records GET /api/public/rooms/<id> (v2): the room's monsters raise its danger and its NPCs are
// placed there. The room is not marked visited.
func (k *Kit) ObserveProbe(w *World, id string, probe jv.Value) {
	if id == "" {
		return
	}
	if w.NPCs == nil {
		w.NPCs = map[string]string{}
	}
	if w.Monsters == nil {
		w.Monsters = map[string]string{}
	}
	if w.Danger == nil {
		w.Danger = map[string]int{}
	}
	ms, _ := probe.Get("monsters")
	if _, ok := w.Danger[id]; !ok {
		w.Danger[id] = 0
	}
	for _, m := range ms.A {
		if l, _ := m.Get("lvl"); int(l.N) > w.Danger[id] {
			w.Danger[id] = int(l.N)
		}
		if n := str(m, "id"); n != "" {
			if _, seen := w.Monsters[n]; !seen {
				w.Monsters[n] = id
			}
		}
	}
	npcs, _ := probe.Get("npcs")
	for _, n := range npcs.A {
		if s := n.Text(); s != "" {
			w.NPCs[s] = id
		}
	}
}

// ToProbe lists the rooms behind the current room's exits whose danger is not known yet, in exit order.
func ToProbe(w World, obs jv.Value) []string {
	exits, _ := jvRoom(obs).Get("exits")
	var out []string
	for _, e := range exits.O {
		id := e.Val.Text()
		if _, known := w.Danger[id]; !known && !contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// Path is the shortest route from one room to another through the exits seen, as directions: breadth-first from
// `from`, exits taken in their listed order, the first route found wins. nil when unknown or when from == to.
func (w World) Path(from, to string) []string {
	if from == to || w.Rooms == nil {
		return nil
	}
	type step struct {
		room string
		dirs []string
	}
	seen := map[string]bool{from: true}
	queue := []step{{from, nil}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, e := range w.Rooms[cur.room] {
			if seen[e[1]] {
				continue
			}
			dirs := append(append([]string{}, cur.dirs...), e[0])
			if e[1] == to {
				return dirs
			}
			seen[e[1]] = true
			queue = append(queue, step{e[1], dirs})
		}
	}
	return nil
}

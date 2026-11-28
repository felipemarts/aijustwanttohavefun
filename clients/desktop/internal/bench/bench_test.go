package bench

import (
	"testing"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

// TestSituationsCode checks every situation's code expectations (menu, mode, routes): no model needed.
func TestSituationsCode(t *testing.T) {
	k := playkit.MustLoad()
	s, sc, m, err := playkit.BenchFiles()
	if err != nil {
		t.Fatal(err)
	}
	b, err := Load(s, sc, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Situations) < 30 {
		t.Fatalf("only %d situations", len(b.Situations))
	}
	for _, sit := range b.Situations {
		turn, _, err := b.Turn(k, sit)
		if err != nil {
			t.Fatalf("%s: %v", sit.ID, err)
		}
		if p := CheckCode(turn, sit.Expect.Code); len(p) > 0 {
			t.Errorf("%s: %v (menu %v)", sit.ID, p, names(turn.Menu))
		}
	}
}

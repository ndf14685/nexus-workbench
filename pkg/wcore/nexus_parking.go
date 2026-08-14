// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Parking (Jarvis UX, ADR-0005): un bloque parkeado sale de tab.blockids y del
// layout pero el objeto Block, su meta y su zona de filestore quedan intactos.
// Fuera de tab.blockids es inmune al GC cleanuporphaned (que solo itera esa
// lista). El nodo de layout lo remueve el frontend ANTES de llamar a ParkBlock.

const (
	MetaKey_NexusParked     = "nexus:parked"
	MetaKey_NexusParkedAt   = "nexus:parked:at"
	MetaKey_NexusParkedFrom = "nexus:parked:from"
	MetaKey_NexusParkedNote = "nexus:parked:note"
)

func ParkBlock(ctx context.Context, blockId string, note string) error {
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		block, _ := wstore.DBGet[*waveobj.Block](tx.Context(), blockId)
		if block == nil {
			return fmt.Errorf("block not found: %q", blockId)
		}
		tabId, _ := wstore.DBFindTabForBlockId(tx.Context(), blockId)
		if tabId != "" {
			tab, _ := wstore.DBGet[*waveobj.Tab](tx.Context(), tabId)
			if tab != nil {
				tab.BlockIds = utilfn.RemoveElemFromSlice(tab.BlockIds, blockId)
				wstore.DBUpdate(tx.Context(), tab)
			}
		}
		if block.Meta == nil {
			block.Meta = waveobj.MetaMapType{}
		}
		block.Meta[MetaKey_NexusParked] = true
		block.Meta[MetaKey_NexusParkedAt] = float64(time.Now().UnixMilli())
		block.Meta[MetaKey_NexusParkedFrom] = tabId
		if note != "" {
			block.Meta[MetaKey_NexusParkedNote] = note
		}
		wstore.DBUpdate(tx.Context(), block)
		return nil
	})
}

// UnparkBlock devuelve el bloque a una tab (la original si sigue viva, si no
// preferredTabId) y encola la acción de layout para que el frontend lo monte.
func UnparkBlock(ctx context.Context, blockId string, preferredTabId string) (string, error) {
	targetTabId, err := wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (string, error) {
		block, _ := wstore.DBGet[*waveobj.Block](tx.Context(), blockId)
		if block == nil {
			return "", fmt.Errorf("block not found: %q", blockId)
		}
		if parked, ok := block.Meta[MetaKey_NexusParked].(bool); !ok || !parked {
			return "", fmt.Errorf("block not parked: %q", blockId)
		}
		originalTabId, _ := block.Meta[MetaKey_NexusParkedFrom].(string)
		tabId := ""
		for _, candidate := range []string{originalTabId, preferredTabId} {
			if candidate == "" {
				continue
			}
			tab, _ := wstore.DBGet[*waveobj.Tab](tx.Context(), candidate)
			if tab != nil {
				tabId = candidate
				break
			}
		}
		if tabId == "" {
			return "", fmt.Errorf("no live tab to restore block %q into", blockId)
		}
		tab, _ := wstore.DBGet[*waveobj.Tab](tx.Context(), tabId)
		if !slices.Contains(tab.BlockIds, blockId) {
			tab.BlockIds = append(tab.BlockIds, blockId)
			wstore.DBUpdate(tx.Context(), tab)
		}
		delete(block.Meta, MetaKey_NexusParked)
		delete(block.Meta, MetaKey_NexusParkedAt)
		delete(block.Meta, MetaKey_NexusParkedFrom)
		delete(block.Meta, MetaKey_NexusParkedNote)
		wstore.DBUpdate(tx.Context(), block)
		return tabId, nil
	})
	if err != nil {
		return "", err
	}
	err = QueueLayoutActionForTab(ctx, targetTabId, waveobj.LayoutActionData{
		ActionType: LayoutActionDataType_Insert,
		BlockId:    blockId,
		Focused:    true,
	})
	if err != nil {
		return targetTabId, fmt.Errorf("block restored but layout action failed: %w", err)
	}
	return targetTabId, nil
}

func ListParkedBlocks(ctx context.Context) ([]*waveobj.Block, error) {
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return nil, err
	}
	var parked []*waveobj.Block
	for _, block := range blocks {
		if isParked, ok := block.Meta[MetaKey_NexusParked].(bool); ok && isParked {
			parked = append(parked, block)
		}
	}
	return parked, nil
}

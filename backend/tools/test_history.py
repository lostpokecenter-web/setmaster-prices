import sys, unittest
sys.path.insert(0, '.')
import pricecharting_history as h

class T(unittest.TestCase):
    def test_merge(self):
        shard = {'items': {}}
        a = {'i': 7, 'l': 159}
        self.assertEqual(h.merge(shard, [a], 100), 1)
        self.assertEqual(h.merge(shard, [a], 101), 0)  # same price: no new row
        self.assertEqual(shard['items']['7'], [[100, 159]])
        self.assertEqual(h.merge(shard, [{'i': 7, 'l': 200, 'k': {'17': 5000}}], 102), 1)
        self.assertEqual(shard['items']['7'][-1], [102, 200, None, None, None, None, None, None, 5000])
        self.assertEqual(h.merge(shard, [{'i': 7, 'l': 210}], 102), 1)  # a re-run on the same day replaces that day's row
        self.assertEqual(len(shard['items']['7']), 2)
        self.assertEqual(h.merge(shard, [{'i': 7}], 103), 1)  # the price disappeared: an empty row ends the line
        self.assertEqual(shard['items']['7'][-1], [103])
        self.assertEqual(h.merge(shard, [{'i': 8}], 103), 0)  # nothing to record for an item that never had a price
        self.assertNotIn('8', shard['items'])

    def test_prune(self):
        shard = {'items': {'1': [[10, 100], [20, 200], [900, 300]]}}
        h.merge(shard, [{'i': 1, 'l': 300}], 1000, keep=400)  # cutoff 600: the 200 price applied then
        self.assertEqual(shard['items']['1'], [[600, 200], [900, 300]])

    def test_daynum(self):
        import datetime
        self.assertEqual(h.daynum(datetime.date(2020, 1, 2)), 1)

class Images(unittest.TestCase):
    def test_plan(self):
        import images_yugioh as im
        cards = [{'card_images': [{'id': 1, 'image_url': 'u1'}, {'id': 2, 'image_url': 'u2'}]}, {'card_images': [{'id': 1, 'image_url': 'u1'}, {'id': 3}]}]
        self.assertEqual(im.plan(cards, {'2.jpg'}), [(1, 'u1')])
        self.assertEqual(im.plan(cards, set()), [(1, 'u1'), (2, 'u2')])


if __name__ == '__main__':
    unittest.main()

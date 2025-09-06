import City from "../Model/City.js";

// ➝ Add a new city with areas
export const addCity = async (req, res) => {
  try {
    const { name, areas } = req.body;

    if (!name) {
      return res.status(400).json({ message: "City name is required" });
    }

    const existingCity = await City.findOne({ name });
    if (existingCity) {
      return res.status(400).json({ message: "City already exists" });
    }

    const city = new City({
      name,
      areas: areas || [],
    });

    await city.save();
    res.status(201).json({ message: "City added successfully", city });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ➝ Get all cities
export const getCities = async (req, res) => {
  try {
    const cities = await City.find().sort({ createdAt: -1 });
    res.json(cities);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ➝ Delete a city
export const deleteCity = async (req, res) => {
  try {
    const { id } = req.params;
    const city = await City.findByIdAndDelete(id);

    if (!city) {
      return res.status(404).json({ message: "City not found" });
    }

    res.json({ message: "City deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ➝ Update a city (name or areas)
export const updateCity = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, areas } = req.body;

    const updatedCity = await City.findByIdAndUpdate(
      id,
      { name, areas },
      { new: true }
    );

    if (!updatedCity) {
      return res.status(404).json({ message: "City not found" });
    }

    res.json({ message: "City updated successfully", city: updatedCity });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
